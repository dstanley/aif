// The Jobs page a page at a time. The AIJob records are paged, sorted and filtered by Rancher's
// SQL-backed API (Steve's cache), so the browser only ever holds the rows it shows; the pods, Jobs,
// claim templates and volumes of those rows are then fetched by the run's job-id label, never the
// whole cluster's. The operator mirrors an AIJob's phase, category and profile into labels
// (ai-factory.suse.com/phase, …/profile) so the state and profile filters run on the server too.
//
// Without the SQL cache (ui-sql-cache off), findPage is unavailable; fetchJobsPage then lists the
// AIJobs once and pages them in the browser, and the related objects still come by label.
import { PaginationArgs, PaginationParamFilter, PaginationSort } from '@shell/types/store/pagination.types';
import { AIJOB_TYPE } from './aijob';
import { GPU_RESOURCE, TYPES } from './config';
import { PROFILE_NAMESPACE } from './profiles';
import { RunSortKey, RunState } from './runs';

export const JOB_ID_LABEL = 'ai-factory.suse.com/job-id';
export const PHASE_LABEL = 'ai-factory.suse.com/phase';
export const PROFILE_LABEL = 'ai-factory.suse.com/profile';

// const enums from @shell do not survive the extension build; these are their string values
const IN = ' IN ' as any;
const NOT_IN = ' NOTIN ' as any;
const EQUALS = '=' as any;

/** The AIJob phases each state the page offers stands for (Admitted shows as Pending). */
export const STATE_PHASES: Partial<Record<RunState, string[]>> = {
  Pending:   ['Pending', 'Admitted'],
  Queued:    ['Queued'],
  Running:   ['Running'],
  Completed: ['Succeeded'],
  Failed:    ['Failed'],
  Cancelled: ['Cancelled'],
};

export const JOB_STATES = Object.keys(STATE_PHASES) as RunState[];

/** Columns the server can sort AIJobs by; the others are not offered. */
export const SORT_FIELDS: Partial<Record<RunSortKey, string>> = {
  created: 'metadata.creationTimestamp',
  name:    'metadata.name',
  project: 'metadata.namespace',
  profile: `metadata.labels[${ PROFILE_LABEL }]`,
  state:   `metadata.labels[${ PHASE_LABEL }]`,
};

export interface JobsQuery {
  page: number;
  pageSize: number;
  sortKey: RunSortKey;
  sortDesc: boolean;
  text: string; // part of a run's name
  namespace: string;
  profile: string;
  state: '' | RunState;
}

/** The server-side request for one page of AIJobs. */
export function jobsPagination(q: JobsQuery): PaginationArgs {
  const filters: PaginationParamFilter[] = [];
  const text = q.text.trim();

  if (text) {
    // partial and case-insensitive (~)
    filters.push(PaginationParamFilter.createSingleField({
      field: 'metadata.name', value: text, equals: true, exact: false
    }) as PaginationParamFilter);
  }
  if (q.namespace) {
    filters.push(PaginationParamFilter.createSingleField({ field: 'metadata.namespace', value: q.namespace, equality: EQUALS }) as PaginationParamFilter);
  }
  if (q.profile) {
    filters.push(PaginationParamFilter.createSingleField({ field: `metadata.labels[${ PROFILE_LABEL }]`, value: q.profile, equality: EQUALS }) as PaginationParamFilter);
  }
  const phases = q.state ? STATE_PHASES[q.state] : undefined;

  if (phases?.length) {
    filters.push(PaginationParamFilter.createSingleField({ field: `metadata.labels[${ PHASE_LABEL }]`, value: phases.join(','), equality: IN }) as PaginationParamFilter);
  }
  const field = SORT_FIELDS[q.sortKey] || SORT_FIELDS.created as string;
  const sort: PaginationSort[] = [{ field, asc: !q.sortDesc }];

  if (field !== SORT_FIELDS.created) {
    sort.push({ field: SORT_FIELDS.created as string, asc: false }); // a stable order within equal values
  }

  return new PaginationArgs({
    page: q.page, pageSize: q.pageSize, sort, filters
  });
}

/** The objects of a set of runs, by their job-id label: one request whatever the cluster holds. */
export function relatedPagination(runNames: string[], pageSize = 500): PaginationArgs {
  return new PaginationArgs({
    page:     1,
    pageSize,
    filters:  [PaginationParamFilter.createSingleField({ field: `metadata.labels[${ JOB_ID_LABEL }]`, value: runNames.join(','), equality: IN }) as PaginationParamFilter],
  });
}

/** The claim templates in a set of namespaces (the chart's carry no job-id label). */
export function namespacesPagination(namespaces: string[], pageSize = 500): PaginationArgs {
  return new PaginationArgs({
    page:     1,
    pageSize,
    // IN, not a comma-separated OR: the cache answers an OR of namespaces unreliably
    filters:  [PaginationParamFilter.createSingleField({ field: 'metadata.namespace', value: namespaces.join(','), equality: IN }) as PaginationParamFilter],
  });
}

export interface JobsPage {
  aiJobs: any[];
  count: number;
  /** false when the server cannot page (no SQL cache) and the page was cut from a full list */
  serverPaged: boolean;
}

async function findPage(store: any, type: string, pagination: PaginationArgs, namespaced?: string): Promise<{ data: any[]; count: number }> {
  const res = await store.dispatch('cluster/findPage', {
    type, opt: {
      pagination, transient: true, watch: false, namespaced
    }
  });

  return { data: res?.data || [], count: res?.pagination?.result?.count ?? (res?.data || []).length };
}

/** The same filters and order, in the browser: the fallback when the server cannot page. */
export function pageLocally(aiJobs: any[], q: JobsQuery): { aiJobs: any[]; count: number } {
  const text = q.text.trim().toLowerCase();
  const phases = q.state ? STATE_PHASES[q.state] || [] : [];
  const val = (j: any): string => {
    switch (q.sortKey) {
    case 'name': return j.metadata?.name || '';
    case 'project': return j.metadata?.namespace || '';
    case 'profile': return j.spec?.profile || '';
    case 'state': return j.status?.phase || '';
    default: return j.metadata?.creationTimestamp || '';
    }
  };
  const shown = aiJobs
    .filter((j) => (!text || (j.metadata?.name || '').toLowerCase().includes(text)) &&
      (!q.namespace || j.metadata?.namespace === q.namespace) &&
      (!q.profile || j.spec?.profile === q.profile) &&
      (!phases.length || phases.includes(j.status?.phase || 'Pending')))
    .sort((a, b) => {
      const c = val(a).localeCompare(val(b)) || (b.metadata?.creationTimestamp || '').localeCompare(a.metadata?.creationTimestamp || '');

      return q.sortDesc ? -c : c;
    });
  const start = (Math.max(1, q.page) - 1) * q.pageSize;

  return { aiJobs: shown.slice(start, start + q.pageSize), count: shown.length };
}

/** One page of AIJobs: from the server when it can page, else cut from the full list. */
export async function fetchJobsPage(store: any, q: JobsQuery): Promise<JobsPage> {
  try {
    const { data, count } = await findPage(store, AIJOB_TYPE, jobsPagination(q));

    return { aiJobs: data, count, serverPaged: true };
  } catch (e: any) {
    // a 422 is a request the cache understood and refused: a real error, not a missing cache
    if (e?.status === 422 || e?._status === 422) {
      throw e;
    }
    const all = await store.dispatch('cluster/findAll', { type: AIJOB_TYPE });

    return { ...pageLocally(all || [], q), serverPaged: false };
  }
}

export interface RelatedObjects {
  pods: any[];
  jobs: any[];
  pytorchJobs: any[];
  pvcs: any[];
  claimTemplates: any[];
  kueueWorkloads: any[];
}

export const NO_RELATED: RelatedObjects = {
  pods: [], jobs: [], pytorchJobs: [], pvcs: [], claimTemplates: [], kueueWorkloads: []
};

/** The pods, Jobs, PyTorchJobs, volumes, claim templates and Kueue Workloads of the runs on a page. */
export async function fetchRelated(store: any, aiJobs: any[]): Promise<RelatedObjects> {
  const names = [...new Set(aiJobs.map((j) => j.metadata?.name).filter(Boolean))] as string[];
  const namespaces = [...new Set(aiJobs.map((j) => j.metadata?.namespace).filter(Boolean))] as string[];

  if (!names.length) {
    return NO_RELATED;
  }
  const has = (type: string) => !!store.getters['cluster/schemaFor'](type);
  const byLabel = async(type: string) => {
    if (!has(type)) {
      return [];
    }
    try {
      return (await findPage(store, type, relatedPagination(names))).data;
    } catch (e) {
      // no SQL cache: the same label selector through the Kubernetes API
      return await store.dispatch('cluster/findMatching', { type, selector: `${ JOB_ID_LABEL } in (${ names.join(',') })` }) || [];
    }
  };
  const inNamespaces = async(type: string) => {
    if (!has(type)) {
      return [];
    }
    try {
      return (await findPage(store, type, namespacesPagination(namespaces))).data;
    } catch (e) {
      return [];
    }
  };
  const [pods, jobs, pytorchJobs, pvcs, claimTemplates, kueueWorkloads] = await Promise.all([
    byLabel(TYPES.POD), byLabel(TYPES.JOB), byLabel(TYPES.PYTORCH_JOB), byLabel(TYPES.PVC),
    inNamespaces(TYPES.RESOURCE_CLAIM_TEMPLATE), inNamespaces(TYPES.WORKLOAD),
  ]);

  return {
    pods, jobs, pytorchJobs, pvcs, claimTemplates, kueueWorkloads
  };
}

/** The compute profiles, from their one namespace rather than every ConfigMap in the cluster. */
export async function fetchProfileConfigMaps(store: any): Promise<any[]> {
  try {
    return (await findPage(store, 'configmap', new PaginationArgs({ page: 1, pageSize: 1000 }), PROFILE_NAMESPACE)).data;
  } catch (e) {
    return await store.dispatch('cluster/findAll', { type: 'configmap', opt: { namespaced: PROFILE_NAMESPACE } }) || [];
  }
}

/** The nodes that offer GPUs (an nvidia.com/gpu allocatable above zero). */
export function gpuNodeNames(nodes: any[]): string[] {
  return nodes.filter((n) => Number(n?.status?.allocatable?.[GPU_RESOURCE] || 0) > 0).map((n) => n.metadata?.name).filter(Boolean);
}

/**
 * The pods that can hold or wait for a GPU: those on a GPU node, and those on no node yet
 * (spec.nodeName NOTIN every node). Every other pod in the cluster is left on the server.
 * Without the SQL cache, every pod (the fallback).
 */
export async function fetchGpuPods(store: any, nodes: any[], fallback: () => Promise<any[]>): Promise<any[]> {
  const gpu = gpuNodeNames(nodes);
  const all = nodes.map((n) => n.metadata?.name).filter(Boolean);
  const onNodes = (names: string[], equality: any) => new PaginationArgs({
    page: 1, pageSize: 5000, filters: [PaginationParamFilter.createSingleField({ field: 'spec.nodeName', value: names.join(','), equality }) as PaginationParamFilter]
  });

  try {
    const [placed, waiting] = await Promise.all([
      gpu.length ? findPage(store, TYPES.POD, onNodes(gpu, IN)) : Promise.resolve({ data: [], count: 0 }),
      all.length ? findPage(store, TYPES.POD, onNodes(all, NOT_IN)) : Promise.resolve({ data: [], count: 0 }),
    ]);

    return [...placed.data, ...waiting.data];
  } catch (e) {
    return await fallback();
  }
}

/** Counts of AIJobs by state from the server (a count each, no records); null when the server cannot count. */
export async function fetchJobCounts(store: any): Promise<{ running: number; queued: number; completed: number; failed: number } | null> {
  const count = async(phases: string[]) => (await findPage(store, AIJOB_TYPE, new PaginationArgs({
    page: 1, pageSize: 1, filters: [PaginationParamFilter.createSingleField({ field: `metadata.labels[${ PHASE_LABEL }]`, value: phases.join(','), equality: IN }) as PaginationParamFilter]
  }))).count;

  try {
    const [running, queued, completed, failed] = await Promise.all([
      count(['Running']), count(['Pending', 'Queued', 'Admitted']), count(['Succeeded']), count(['Failed', 'Cancelled']),
    ]);

    return {
      running, queued, completed, failed
    };
  } catch (e) {
    return null;
  }
}
