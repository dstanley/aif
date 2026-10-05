import { describe, expect, it } from 'vitest';
import { jobCounts, jobRows } from '../clusteroverview';

const job = (name: string, phase: string, extra: any = {}) => ({
  metadata: { name, namespace: 'aif-test', creationTimestamp: extra.at || '2026-10-05T16:00:00Z' },
  spec:     { displayName: extra.title || '', profile: extra.profile || '' },
  status:   { phase, submittedAt: extra.at, ...extra.status },
});

describe('the cluster overview', () => {
  const jobs = [
    job('smoke-1', 'Succeeded', {
      at: '2026-10-05T16:07:14Z', title: 'GPU Smoke Test', profile: 'gpu-smoke',
      status: {
        resources: { gpuCount: 1, gpus: [{ product: 'NVIDIA-A2' }] }, pods: [{ node: 'ampere-2.5glinux.com' }],
        report: { status: 'pass', checks: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }] }
      }
    }),
    job('train-2', 'Running', { at: '2026-10-05T15:00:00Z' }),
    job('train-3', 'Failed', { at: '2026-10-05T16:30:00Z', status: { result: { exitCode: 1, reason: 'BackoffLimitExceeded' } } }),
    job('train-4', 'Queued', { at: '2026-10-05T16:40:00Z' }),
  ];

  it('counts runs by the state that matters to someone watching the GPUs', () => {
    expect(jobCounts(jobs)).toEqual({
      running: 1, queued: 1, succeeded: 1, failed: 1
    });
  });

  it('lists active runs first, then the most recent, with where they ran and how they ended', () => {
    const rows = jobRows(jobs);

    expect(rows.map((r) => r.name)).toEqual(['train-4', 'train-2', 'train-3', 'smoke-1']);
    expect(rows[3]).toMatchObject({
      title: 'GPU Smoke Test', profile: 'gpu-smoke', gpus: '1 × NVIDIA-A2', nodes: 'ampere-2', result: 'pass (4/4 checks)', color: 'bg-success'
    });
    expect(rows[2].result).toBe('exit 1 · BackoffLimitExceeded');
    expect(rows[0]).toMatchObject({ title: 'train-4', gpus: '–', result: '' });
  });
});
