import { describe, expect, it } from 'vitest';
import { aiClusterRows } from '../aiclusters';

const prov = (clusterName: string, name: string, ai = false) => ({
  metadata: { namespace: 'fleet-default', name, labels: ai ? { 'ai-factory.suse.com/enabled': 'true' } : {} },
  status:   { clusterName },
});

describe('the Clusters page', () => {
  const rows = aiClusterRows({
    clusters: [
      { id: 'local', name: 'local' }, { id: 'c-a', name: 'altra-ai' }, { id: 'c-b', name: 'dgx' }, { id: 'c-c', name: 'edge' }, { id: 'c-d', name: 'saif-runner' },
    ],
    training: [
      { id: 'local', name: 'local', jobs: [], error: '' },
      { id: 'c-a', name: 'altra-ai', jobs: [{ status: { phase: 'Running' } }, { status: { phase: 'Succeeded' } }], error: '' },
      { id: 'c-d', name: 'saif-runner', jobs: [], error: '' },
    ],
    provisioning: [prov('c-a', 'altra-ai', true), prov('c-b', 'dgx', true), prov('c-c', 'edge'), prov('c-d', 'saif-runner')],
    aiProjects:   [{ metadata: { namespace: 'c-a' } }, { metadata: { namespace: 'c-a' } }],
    workloads:    [{ spec: { targetClusters: ['c-d'] } }],
    gpus:         { 'c-a': { count: 3, models: ['NVIDIA-A2'] }, 'c-c': null },
    count:        (jobs) => jobs.filter((j) => j.status.phase === 'Running').length,
  });
  const by = (name: string) => rows.find((r) => r.name === name)!;

  it('tells apart the management cluster, enabled, enabling, installed-by-hand and off', () => {
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['local', 'management'], ['altra-ai', 'enabled'], ['saif-runner', 'manual'], ['dgx', 'enabling'], ['edge', 'off'],
    ]);
  });

  it('says what each has and runs, and where the AI label goes', () => {
    expect(by('altra-ai')).toMatchObject({
      gpus: { count: 3, models: ['NVIDIA-A2'] }, running: 1, aiProjects: 2, provisioning: { namespace: 'fleet-default', name: 'altra-ai' }
    });
    expect(by('saif-runner').workloads).toBe(1);
    expect(by('edge').gpus).toBeNull();
    expect(by('local').provisioning).toBeNull();
  });
});

describe('where the AI label is read, and a missing installer', () => {
  const base = {
    clusters:   [{ id: 'local', name: 'local' }, { id: 'c-i', name: 'imported' }],
    training:   [{ id: 'local', name: 'local', jobs: [], error: '' }],
    provisioning: [prov('c-i', 'imported')], // an imported cluster: its provisioning object has no label
    management: [{ metadata: { name: 'c-i', labels: { 'ai-factory.suse.com/enabled': 'true' } } }],
    aiProjects: [],
    workloads:  [],
    gpus:       {},
    count:      () => 0,
  };

  it('counts the label on the management cluster object, which Fleet reads', () => {
    expect(aiClusterRows(base).find((r) => r.id === 'c-i')!.state).toBe('enabling');
  });

  it('says so when AI Factory installs no agent, rather than enabling forever', () => {
    expect(aiClusterRows({ ...base, installer: false }).find((r) => r.id === 'c-i')!.state).toBe('noagent');
    expect(aiClusterRows({ ...base, installer: true }).find((r) => r.id === 'c-i')!.state).toBe('enabling');
  });
});

describe('status, GPU names and the install steps', async() => {
  const { statusOf, gpuName, gpuCapacity, installSteps } = await import('../aiclusters');
  const fine = { installer: true, fleetLastSeen: '2026-10-07T01:00:00Z', fleetStale: false, answers: false };

  it('names the status a person needs', () => {
    expect(statusOf('management', fine)).toBe('ready');
    expect(statusOf('enabled', fine)).toBe('ready');
    expect(statusOf('off', fine)).toBe('off');
    expect(statusOf('enabling', fine)).toBe('installing');
    expect(statusOf('noagent', fine)).toBe('attention');
    expect(statusOf('enabling', { ...fine, fleetStale: true })).toBe('attention');
    expect(statusOf('enabling', { ...fine, bundle: { state: 'ErrApplied', message: 'x', notReady: [] } })).toBe('attention');
    expect(statusOf('enabling', { ...fine, bundle: { state: 'NotReady', message: '', notReady: [] } })).toBe('installing');
  });

  it('says GPU models as people do', () => {
    expect(gpuName('NVIDIA-RTX-A2000-12GB')).toBe('RTX A2000 12 GB');
    expect(gpuName('NVIDIA-A100-SXM4-40GB')).toBe('A100 SXM4 40 GB');
    expect(gpuCapacity({ count: 1, models: ['NVIDIA-RTX-A2000-12GB'] })).toBe('1 × RTX A2000 12 GB');
    expect(gpuCapacity({ count: 0, models: [] })).toBe('');
    expect(gpuCapacity(null)).toBe('');
  });

  it('shows where an install is stuck', () => {
    const row: any = { state: 'enabling', install: { ...fine, fleetStale: true, fleetLastSeen: '2026-03-21T16:11:17Z', bundle: { state: 'WaitApplied', message: '', notReady: [] } } };
    const steps = installSteps(row, () => '6 months ago');

    expect(steps.map((s) => [s.name, s.ok])).toEqual([
      ['Requested', true], ['AI Factory installer', true], ['Fleet agent on the cluster', false], ['Training agent installed', null], ['Training agent answers', null],
    ]);
    expect(steps[2].detail).toBe('last checked in 6 months ago: it cannot reach Rancher');
    expect(installSteps({ ...row, install: { ...row.install, installer: false } }, () => '')[1].ok).toBe(false);
  });
});

describe('the agent bundle', () => {
  it('is read from the agent bundle only, not a cluster\'s other bundles', () => {
    const bd = (cluster: string, bundle: string, state: string) => ({ metadata: { labels: { 'fleet.cattle.io/cluster': cluster, 'fleet.cattle.io/bundle-name': bundle } }, status: { display: { state } } });
    const rows = aiClusterRows({
      clusters:     [{ id: 'local', name: 'local' }, { id: 'c-i', name: 'imported' }],
      training:     [],
      provisioning: [prov('c-i', 'imported', true)],
      agentBundles: [bd('local', 'qwen-shared-vllm', 'Modified'), bd('c-i', 'qwen-shared-vllm', 'Modified'), bd('c-i', 'aif-operator-cluster-agent', 'NotReady')],
      aiProjects:   [],
      workloads:    [],
      gpus:         {},
      count:        () => 0,
    });

    expect(rows.find((r) => r.id === 'local')!.install.bundle).toBeUndefined();
    expect(rows.find((r) => r.id === 'c-i')!.install.bundle!.state).toBe('NotReady');
    expect(rows.find((r) => r.id === 'c-i')!.status).toBe('installing');
  });
});
