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
