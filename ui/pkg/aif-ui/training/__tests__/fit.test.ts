import { describe, expect, it } from 'vitest';
import { fitOf, needsOf, nodeFacts, parseRequires } from '../fit';
import { fitCatalog } from '../catalog';
import { profileFitCheck } from '../preflight';

const node = (name: string, labels: Record<string, string>, gpus: number) => ({ metadata: { name, labels }, status: { allocatable: { 'nvidia.com/gpu': String(gpus) } } });
// as the lab's GPU node reports itself (GPU Feature Discovery)
const A2000 = node('rke2-worker1', {
  'kubernetes.io/arch': 'amd64', 'nvidia.com/gpu.memory': '12282', 'nvidia.com/gpu.compute.major': '8', 'nvidia.com/gpu.compute.minor': '6',
  'nvidia.com/cuda.driver-version.major': '580', 'nvidia.com/gpu.product': 'NVIDIA-RTX-A2000-12GB'
}, 1);
const GB200 = node('gb200', {
  'kubernetes.io/arch': 'arm64', 'nvidia.com/gpu.memory': '189471', 'nvidia.com/gpu.compute.major': '10', 'nvidia.com/gpu.compute.minor': '0',
  'nvidia.com/cuda.driver-version.major': '580', 'nvidia.com/gpu.product': 'NVIDIA-GB200'
}, 2);
const CPU = node('cpu-1', { 'kubernetes.io/arch': 'amd64' }, 0);
const lab = nodeFacts([A2000, CPU]);
const gb = nodeFacts([GB200]);

const profile = (form: any, requires: any = {}, extra: any = {}) => ({
  type: 'training', form: { gpuMode: 'auto', gpusPerNode: 1, gpuShareMiB: 0, ...form }, requires, ...extra
});

describe('parseRequires', () => {
  it('reads what a profile may require, and says what it cannot', () => {
    const problems: string[] = [];

    expect(parseRequires({
      gpuMemoryGiB: 70, computeCapability: '9.0', arch: 'arm64', nodes: 2
    }, problems)).toEqual({
      gpuMemoryGiB: 70, computeCapability: '9.0', arch: ['arm64'], nodes: 2
    });
    expect(problems).toEqual([]);
    parseRequires({ vram: 12, computeCapability: 'hopper', driver: 'new' }, problems);
    expect(problems).toHaveLength(3);
  });
});

describe('nodeFacts', () => {
  it('reads GPU Feature Discovery\'s labels and the allocatable GPUs', () => {
    expect(lab[0]).toMatchObject({
      arch: 'amd64', gpus: 1, gpuMemoryMiB: 12282, computeCapability: [8, 6], driver: 580
    });
    expect(lab[1]).toMatchObject({ gpus: 0, gpuMemoryMiB: null, computeCapability: null });
  });
});

describe('fitOf', () => {
  it('a 70 GB model fits a GB200, not an A2000, and says why', () => {
    const big = needsOf(profile({}, { gpuMemoryGiB: 70, computeCapability: '9.0' }));

    expect(fitOf(big, gb).fits).toBe(true);
    const f = fitOf(big, lab);

    expect(f.fits).toBe(false);
    expect(f.reasons[0]).toBe('it needs 70 GiB of GPU memory, compute capability 9.0; this cluster\'s best is 12 GiB GPUs, compute capability 8.6, driver 580');
  });

  it('images for one CPU architecture do not run on the other', () => {
    expect(fitOf(needsOf(profile({}, { arch: ['amd64'] })), gb).reasons[0]).toContain('built for amd64; this cluster\'s nodes are arm64');
    expect(fitOf(needsOf(profile({}, { arch: ['amd64', 'arm64'] })), gb).fits).toBe(true);
  });

  it('a CPU profile needs no GPU; a GPU profile needs one', () => {
    expect(fitOf(needsOf(profile({ gpuMode: 'none' })), nodeFacts([CPU])).fits).toBe(true);
    expect(fitOf(needsOf(profile({})), nodeFacts([CPU])).reasons).toEqual(['it needs a GPU, and this cluster has none']);
  });

  it('a GPU share needs KAI sharing and a GPU at least that big', () => {
    const share = needsOf(profile({ gpuShareMiB: 4096 }));

    expect(fitOf(share, lab, true).fits).toBe(true);
    expect(fitOf(share, lab, false).reasons[0]).toContain('KAI GPU sharing');
    expect(fitOf(needsOf(profile({ gpuShareMiB: 16384 })), lab, true).fits).toBe(false);
  });

  it('several GPUs per worker need a node with that many, from the fewest a user may choose', () => {
    expect(fitOf(needsOf(profile({ gpusPerNode: 2 })), gb).fits).toBe(true);
    expect(fitOf(needsOf(profile({ gpusPerNode: 2 })), lab).fits).toBe(false);
    expect(fitOf(needsOf(profile({ gpusPerNode: 2 }, {}, { limits: { gpusPerNode: { min: 1, max: 2 } } })), lab).fits).toBe(true);
  });

  it('a multi-node run needs that many nodes that each qualify', () => {
    expect(fitOf(needsOf(profile({}, { nodes: 2 })), lab).reasons).toEqual(['it needs 2 GPU nodes that meet its needs; this cluster has 1']);
  });

  it('several workers need a GPU each, in all, from the fewest a user may choose', () => {
    const two = profile({ nodes: 2 }, {}, { limits: { nodes: { min: 2, max: 8 } } });

    expect(fitOf(needsOf(two), lab).reasons).toEqual(['it needs 2 GPUs in all (one per worker at least); this cluster has 1']);
    expect(fitOf(needsOf(two), gb).fits).toBe(true);
    expect(fitOf(needsOf(profile({ nodes: 2 }, {}, { limits: { nodes: { min: 1, max: 4 } } })), lab).fits).toBe(true);
  });

  it('a fact a node does not report does not rule a profile out', () => {
    const bare = nodeFacts([node('n', {}, 1)]);

    expect(fitOf(needsOf(profile({}, { gpuMemoryGiB: 70, computeCapability: '9.0', driver: 580 })), bare).fits).toBe(true);
  });
});

describe('fitCatalog', () => {
  const item = (key: string, p: any) => ({ key, from: 'profile', profile: p } as any);
  const items = [item('small', profile({})), item('big', profile({}, { gpuMemoryGiB: 70 })), { key: 'bp', from: 'blueprint', profile: null } as any];

  it('hides what the cluster cannot run, counts it, and keeps the reasons for Show all', () => {
    const f = fitCatalog(items, lab, true, false);

    expect(f.items.map((i) => i.key)).toEqual(['small', 'bp']);
    expect(f.hidden).toBe(1);
    expect(fitCatalog(items, lab, true, true).items).toHaveLength(3);
    expect(fitCatalog(items, lab, true, true).misfit.big[0]).toContain('70 GiB');
  });

  it('leaves everything in when the nodes could not be read', () => {
    expect(fitCatalog(items, null, null, false).items).toHaveLength(3);
  });
});

describe('profileFitCheck', () => {
  it('fails the run before it starts when the cluster cannot run the profile', () => {
    const facts: any = { loaded: true, kaiInstalled: true, nodeFacts: lab };

    expect(profileFitCheck({ ...profile({}, { gpuMemoryGiB: 70 }), displayName: 'Llama 70B' }, facts)).toMatchObject({ severity: 'fail', title: 'Llama 70B cannot run on this cluster' });
    expect(profileFitCheck({ ...profile({}), displayName: 'Small' }, facts)?.severity).toBe('pass');
    expect(profileFitCheck(null, facts)).toBeNull();
  });
});
