// A cluster's Data: the volumes AI runs created there, a page at a time, paged, sorted and filtered
// by the server (as jobspage.ts does for the runs). The gpu-train-job chart labels both kinds it
// makes with app.kubernetes.io/name=gpu-train-job and the run's job-id: a checkpoint volume
// (<run>-checkpoints, kept after the run) and a scratch volume per pod (<pod>-scratch, owned by the
// pod, gone with it). "All volumes" drops that label filter, for volumes made some other way.
import { PaginationArgs, PaginationParamFilter, PaginationSort } from '@shell/types/store/pagination.types';
import { TYPES } from './config';
import { CheckpointVolume } from './checkpoints';
import { JOB_ID_LABEL } from './jobspage';

const IN = ' IN ' as any;
const EQUALS = '=' as any;

export type VolumeKind = 'checkpoint' | 'scratch' | 'other';
export type VolumeScope = 'runs' | 'checkpoint' | 'scratch' | 'all';
export type VolumeSortKey = 'created' | 'name' | 'namespace';

export const CHART_NAME_LABEL = 'app.kubernetes.io/name';
export const CHART = 'gpu-train-job';

export interface VolumesQuery {
  page: number;
  pageSize: number;
  sortKey: VolumeSortKey;
  sortDesc: boolean;
  text: string;
  namespace: string;
  scope: VolumeScope;
}

const SORT: Record<VolumeSortKey, string> = {
  created:   'metadata.creationTimestamp',
  name:      'metadata.name',
  namespace: 'metadata.namespace',
};

const contains = (field: string, value: string) => PaginationParamFilter.createSingleField({
  field, value, equals: true, exact: false
}) as PaginationParamFilter;
const equals = (field: string, value: string) => PaginationParamFilter.createSingleField({ field, value, equality: EQUALS }) as PaginationParamFilter;

/** The server-side request for one page of volumes. */
export function volumesPagination(q: VolumesQuery): PaginationArgs {
  const filters: PaginationParamFilter[] = [];

  if (q.scope !== 'all') {
    filters.push(equals(`metadata.labels[${ CHART_NAME_LABEL }]`, CHART));
  }
  if (q.scope === 'checkpoint') {
    filters.push(contains('metadata.name', '-checkpoints'));
  } else if (q.scope === 'scratch') {
    filters.push(contains('metadata.name', '-scratch'));
  }
  if (q.text.trim()) {
    filters.push(contains('metadata.name', q.text.trim()));
  }
  if (q.namespace) {
    filters.push(equals('metadata.namespace', q.namespace));
  }
  const sort: PaginationSort[] = [{ field: SORT[q.sortKey] || SORT.created, asc: !q.sortDesc }];

  if (q.sortKey !== 'created') {
    sort.push({ field: SORT.created, asc: false });
  }

  return new PaginationArgs({
    page: q.page, pageSize: q.pageSize, sort, filters
  });
}

/** What a volume is: a run's kept checkpoints, a pod's scratch space, or something else. */
export function volumeKind(pvc: any): VolumeKind {
  const l = pvc?.metadata?.labels || {};
  const name = pvc?.metadata?.name || '';

  if (l[CHART_NAME_LABEL] !== CHART) {
    return 'other';
  }
  if ((pvc?.metadata?.ownerReferences || []).some((o: any) => o?.kind === 'Pod') || name.endsWith('-scratch')) {
    return 'scratch';
  }

  return name.endsWith('-checkpoints') ? 'checkpoint' : 'other';
}

export interface VolumeRow {
  key: string;
  obj: any;
  name: string;
  namespace: string;
  run: string; // the run that made it, '' for another volume
  kind: VolumeKind;
  size: string;
  storageClass: string;
  created: string;
  inUseBy: string[]; // pods not yet finished that mount it
  ownerPod: string; // a scratch volume's pod, which deletes it when it goes
}

/** The page's rows, with the pods (not yet finished) that mount each volume. */
export function volumeRows(pvcs: any[], pods: any[]): VolumeRow[] {
  const mounts: Record<string, string[]> = {};

  for (const p of pods || []) {
    if (['Succeeded', 'Failed'].includes(p?.status?.phase)) {
      continue;
    }
    for (const v of p?.spec?.volumes || []) {
      // a generic ephemeral volume's claim is <pod>-<volume>
      const claim = v?.persistentVolumeClaim?.claimName || (v?.ephemeral ? `${ p.metadata?.name }-${ v.name }` : '');

      if (claim) {
        const k = `${ p.metadata?.namespace }/${ claim }`;

        (mounts[k] = mounts[k] || []).push(p.metadata?.name);
      }
    }
  }

  return (pvcs || []).map((v: any): VolumeRow => {
    const ns = v.metadata?.namespace || '';
    const name = v.metadata?.name || '';

    return {
      key:          `${ ns }/${ name }`,
      obj:          v,
      name,
      namespace:    ns,
      run:          v.metadata?.labels?.[JOB_ID_LABEL] || '',
      kind:         volumeKind(v),
      size:         v.status?.capacity?.storage || v.spec?.resources?.requests?.storage || '',
      storageClass: v.spec?.storageClassName || '',
      created:      v.metadata?.creationTimestamp || '',
      inUseBy:      mounts[`${ ns }/${ name }`] || [],
      ownerPod:     (v.metadata?.ownerReferences || []).find((o: any) => o?.kind === 'Pod')?.name || '',
    };
  });
}

/** The row as the file browser (VolumeFiles) takes a volume. */
export function asCheckpoint(r: VolumeRow): CheckpointVolume {
  return {
    obj: r.obj, name: r.name, namespace: r.namespace, run: r.run, size: r.size, storageClass: r.storageClass, created: r.created, inUseBy: r.inUseBy, runActive: false
  };
}

async function findPage(store: any, type: string, pagination: PaginationArgs): Promise<{ data: any[]; count: number }> {
  const res = await store.dispatch('cluster/findPage', {
    type, opt: {
      pagination, transient: true, watch: false
    }
  });

  return { data: res?.data || [], count: res?.pagination?.result?.count ?? (res?.data || []).length };
}

export interface VolumesPage {
  rows: VolumeRow[];
  count: number;
}

/**
 * One page of volumes, then the pods that may mount them: a run's pods by its job-id label, and
 * for volumes no run made, the pods of their namespaces.
 */
export async function fetchVolumesPage(store: any, q: VolumesQuery): Promise<VolumesPage> {
  const { data: pvcs, count } = await findPage(store, TYPES.PVC, volumesPagination(q));
  const runs = [...new Set(pvcs.map((v) => v.metadata?.labels?.[JOB_ID_LABEL]).filter(Boolean))] as string[];
  const otherNamespaces = [...new Set(pvcs.filter((v) => !v.metadata?.labels?.[JOB_ID_LABEL]).map((v) => v.metadata?.namespace))] as string[];
  const podsBy = (field: string, values: string[]) => (values.length ? findPage(store, TYPES.POD, new PaginationArgs({
    page: 1, pageSize: 2000, filters: [PaginationParamFilter.createSingleField({ field, value: values.join(','), equality: IN }) as PaginationParamFilter]
  })).then((r) => r.data) : Promise.resolve([]));
  const [runPods, nsPods] = await Promise.all([
    podsBy(`metadata.labels[${ JOB_ID_LABEL }]`, runs),
    podsBy('metadata.namespace', otherNamespaces),
  ]);

  return { rows: volumeRows(pvcs, [...runPods, ...nsPods]), count };
}

export interface StorageNode {
  name: string;
  freeGiB: number; // the most room left to reserve on one of its disks
}

export interface StorageSummary {
  reservedGiB: number;
  capacityGiB: number;
  nodes: StorageNode[];
  /** Nodes with room for a new 10 GiB replica; a 3-replica volume needs three of them. */
  nodesWithRoom: number;
}

const G = 2 ** 30;

/** Longhorn's reservations, from its node objects: what a new volume can still be given. */
export function longhornSummary(nodes: any[], replicaGiB = 10): StorageSummary | null {
  const usable = (nodes || []).filter((n) => n?.spec?.allowScheduling !== false);

  if (!usable.length) {
    return null;
  }
  let reserved = 0;
  let capacity = 0;
  const out: StorageNode[] = usable.map((n: any) => {
    let free = 0;

    for (const d of Object.values(n?.status?.diskStatus || {}) as any[]) {
      reserved += Number(d?.storageScheduled || 0);
      capacity += Number(d?.storageMaximum || 0);
      free = Math.max(free, (Number(d?.storageMaximum || 0) - Number(d?.storageScheduled || 0)) / G);
    }

    return { name: n.metadata?.name || '', freeGiB: Math.floor(free) };
  });

  return {
    reservedGiB:   Math.round(reserved / G),
    capacityGiB:   Math.round(capacity / G),
    nodes:         out.sort((a, b) => a.freeGiB - b.freeGiB),
    nodesWithRoom: out.filter((n) => n.freeGiB >= replicaGiB).length,
  };
}

export const LONGHORN_NODE = 'longhorn.io.node';

/** Longhorn's summary when this user can read its nodes (platform admins), else null. */
export async function fetchStorageSummary(store: any): Promise<StorageSummary | null> {
  if (!store.getters['cluster/schemaFor'](LONGHORN_NODE)) {
    return null;
  }
  try {
    return longhornSummary(await store.dispatch('cluster/findAll', { type: LONGHORN_NODE, opt: { force: true } }));
  } catch (e) {
    return null;
  }
}
