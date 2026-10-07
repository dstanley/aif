import { describe, expect, it, vi } from 'vitest';
import stevePaginationUtils from '@shell/plugins/steve/steve-pagination-utils';
import {
  cleanUpRun, freeToDelete, longhornSummary, until, volumeKind, volumeRows, volumesPagination, VolumesQuery
} from '../datapage';
import { fetchGpuPods, fetchJobCounts, gpuNodeNames } from '../jobspage';

const params = (pagination: any) => decodeURIComponent(stevePaginationUtils.createParamsForPagination({ opt: { pagination } as any }) || '');

const Q: VolumesQuery = {
  page: 1, pageSize: 25, sortKey: 'created', sortDesc: true, text: '', namespace: '', scope: 'runs'
};

const pvc = (name: string, labels: Record<string, string> = {}, extra: any = {}) => ({
  metadata: {
    name, namespace: 'aif-submit', labels, creationTimestamp: '2026-10-07T00:00:00Z', ownerReferences: extra.owner ? [{ kind: 'Pod', name: extra.owner }] : []
  },
  spec:   { storageClassName: 'longhorn', resources: { requests: { storage: '5Gi' } } },
  status: { capacity: { storage: '5Gi' } },
});
const RUN = { 'app.kubernetes.io/name': 'gpu-train-job', 'ai-factory.suse.com/job-id': 'dev-a' };

describe('volumesPagination', () => {
  it('lists the volumes runs made, newest first', () => {
    expect(params(volumesPagination(Q))).toBe('page=1&pagesize=25&sort=-metadata.creationTimestamp&filter=metadata.labels[app.kubernetes.io/name]="gpu-train-job"');
  });

  it('narrows to checkpoints or scratch by name, and drops the chart filter for all volumes', () => {
    expect(params(volumesPagination({ ...Q, scope: 'checkpoint' }))).toContain('filter=metadata.name~"-checkpoints"');
    expect(params(volumesPagination({ ...Q, scope: 'scratch' }))).toContain('filter=metadata.name~"-scratch"');
    expect(params(volumesPagination({ ...Q, scope: 'all' }))).not.toContain('app.kubernetes.io/name');
  });

  it('filters by name and namespace, and sorts by name with the newest first within', () => {
    const p = params(volumesPagination({
      ...Q, text: 'lora', namespace: 'aif-submit', sortKey: 'name', sortDesc: false
    }));

    expect(p).toContain('filter=metadata.name~lora');
    expect(p).toContain('filter=metadata.namespace="aif-submit"');
    expect(p).toContain('sort=metadata.name,-metadata.creationTimestamp');
  });
});

describe('volumeKind', () => {
  it('tells checkpoints, scratch and other volumes apart', () => {
    expect(volumeKind(pvc('dev-a-checkpoints', RUN))).toBe('checkpoint');
    expect(volumeKind(pvc('dev-a-0-xk2-scratch', RUN, { owner: 'dev-a-0-xk2' }))).toBe('scratch');
    expect(volumeKind(pvc('dev-a-restored', { app: 'aif-data-lifecycle' }))).toBe('other');
  });
});

describe('volumeRows', () => {
  const running = (name: string, volumes: any[]) => ({
    metadata: { name, namespace: 'aif-submit' }, spec: { volumes }, status: { phase: 'Running' }
  });

  it('marks a volume a running pod mounts, by claim or as its ephemeral scratch', () => {
    const rows = volumeRows(
      [pvc('dev-a-checkpoints', RUN), pvc('dev-a-0-xk2-scratch', RUN, { owner: 'dev-a-0-xk2' }), pvc('dev-old-checkpoints', RUN)],
      [running('dev-a-0-xk2', [{ name: 'checkpoints', persistentVolumeClaim: { claimName: 'dev-a-checkpoints' } }, { name: 'scratch', ephemeral: {} }])]
    );

    expect(rows.map((r) => [r.name, r.inUseBy])).toEqual([
      ['dev-a-checkpoints', ['dev-a-0-xk2']], ['dev-a-0-xk2-scratch', ['dev-a-0-xk2']], ['dev-old-checkpoints', []],
    ]);
    expect(rows[0]).toMatchObject({
      run: 'dev-a', kind: 'checkpoint', size: '5Gi', storageClass: 'longhorn'
    });
    expect(rows[1].ownerPod).toBe('dev-a-0-xk2');
  });

  it('a finished pod no longer uses its volume, but holds it until the run is cleaned up', () => {
    const done = { ...running('dev-a-0', [{ name: 'c', persistentVolumeClaim: { claimName: 'dev-a-checkpoints' } }]), status: { phase: 'Succeeded' } };
    const [r] = volumeRows([pvc('dev-a-checkpoints', RUN)], [done]);

    expect(r.inUseBy).toEqual([]);
    expect(r.heldBy).toEqual(['dev-a-0']);
    expect(freeToDelete(r)).toBe(false);
  });

  it('only a volume no pod names, and not already being deleted, is free to delete', () => {
    const deleting = pvc('dev-b-checkpoints', RUN);

    (deleting.metadata as any).deletionTimestamp = '2026-10-07T22:57:48Z';
    const [free, gone] = volumeRows([pvc('dev-a-checkpoints', RUN), deleting], []);

    expect(freeToDelete(free)).toBe(true);
    expect(gone.deleting).toBe(true);
    expect(freeToDelete(gone)).toBe(false);
  });
});

describe('longhornSummary', () => {
  const G = 2 ** 30;
  const node = (name: string, disks: [number, number][], allow = true) => ({
    metadata: { name },
    spec:     { allowScheduling: allow },
    status:   { diskStatus: Object.fromEntries(disks.map(([max, sched], i) => [`d${ i }`, { storageMaximum: max * G, storageScheduled: sched * G }])) },
  });

  it('counts what is reserved, and the nodes with room for a new replica', () => {
    const s = longhornSummary([node('a', [[300, 299], [73, 64]]), node('b', [[300, 150]]), node('c', [[12, 10]]), node('m', [[24, 0]], false)]);

    expect(s).toMatchObject({ reservedGiB: 523, capacityGiB: 685, nodesWithRoom: 1 });
    expect(s?.nodes.map((n) => [n.name, n.freeGiB])).toEqual([['c', 2], ['a', 9], ['b', 150]]);
  });

  it('is nothing without schedulable nodes', () => {
    expect(longhornSummary([])).toBeNull();
  });
});

describe('the Overview reads only what it shows', () => {
  const nodes = [
    { metadata: { name: 'gpu1' }, status: { allocatable: { 'nvidia.com/gpu': '1' } } },
    { metadata: { name: 'cpu1' }, status: { allocatable: { cpu: '8' } } },
  ];

  it('GPU nodes are those with an nvidia.com/gpu to allocate', () => {
    expect(gpuNodeNames(nodes)).toEqual(['gpu1']);
  });

  it('pods: those on GPU nodes, and those on no node yet', async() => {
    const urls: string[] = [];
    const dispatch = vi.fn(async(_: string, { opt }: any) => {
      urls.push(params(opt.pagination));

      return { data: [{ metadata: { name: `p${ urls.length }` } }], pagination: { result: { count: 1 } } };
    });
    const pods = await fetchGpuPods({ dispatch }, nodes, async() => []);

    expect(pods).toHaveLength(2);
    expect(urls).toEqual(expect.arrayContaining([
      expect.stringContaining('filter=spec.nodeName IN (gpu1)'),
      expect.stringContaining('filter=spec.nodeName NOTIN (gpu1,cpu1)'),
    ]));
  });

  it('job counts: one count per state from the server, no records', async() => {
    const counts: Record<string, number> = {
      Running: 2, 'Pending,Queued,Admitted': 1, Succeeded: 40, 'Failed,Cancelled': 3
    };
    const dispatch = vi.fn(async(_: string, { opt }: any) => {
      const phases = params(opt.pagination).match(/IN \(([^)]*)\)/)?.[1] || '';

      expect(opt.pagination.pageSize).toBe(1);

      return { data: [], pagination: { result: { count: counts[phases] } } };
    });

    expect(await fetchJobCounts({ dispatch })).toEqual({
      running: 2, queued: 1, completed: 40, failed: 3
    });
  });

  it('job counts: null when the server cannot count, so the page counts the list', async() => {
    expect(await fetchJobCounts({ dispatch: vi.fn(async() => Promise.reject(new Error('no cache'))) })).toBeNull();
  });
});

describe('cleanUpRun', () => {
  it('shortens the run\'s retention with a merge patch, so the operator removes its pods now', async() => {
    const dispatch = vi.fn(async() => ({}));

    await cleanUpRun({ dispatch }, 'local', 'aif-submit', 'dev-a');
    expect(dispatch).toHaveBeenCalledWith('cluster/request', {
      url:     '/k8s/clusters/local/apis/ai-factory.suse.com/v1alpha1/namespaces/aif-submit/aijobs/dev-a',
      method:  'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      data:    { spec: { retention: { executionObjects: '1m' } } },
    });
  });
});

describe('until', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');

  it('says how long until a time, roughly', () => {
    expect(until('2026-10-13T06:00:00Z', now)).toBe('in 5 days');
    expect(until('2026-10-08T03:30:00Z', now)).toBe('in 3 hours');
    expect(until('2026-10-08T00:20:00Z', now)).toBe('within the hour');
    expect(until('2026-10-07T23:00:00Z', now)).toBe('any minute');
    expect(until('', now)).toBe('');
  });
});
