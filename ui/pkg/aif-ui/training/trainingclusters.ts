// Training across clusters. A job runs, and its AIJob record lives, on the cluster whose GPUs it
// uses; there is no copy on the management cluster. So the global Jobs page and Deploy's cluster
// choice ask each cluster in turn, through Rancher's cluster proxy and with the user's own identity,
// which clusters serve the AIJob API and what runs there. A cluster that does not serve it is not a
// training cluster; one the user cannot read is listed with that said, not hidden.

import { NodeFacts, nodeFacts } from './fit';
import { getClusters } from '../services/cluster-service';

export const AIJOB_LIST_PATH = '/apis/ai-factory.suse.com/v1alpha1/aijobs';

export interface TrainingCluster {
  id: string;
  name: string;
  jobs: any[];
  /** why the jobs could not be read ('' when they were) */
  error: string;
}

/** The HTTP status of a rejected Rancher request; Steve sets a non-enumerable _status on every rejection. */
export function httpStatus(e: any): number | undefined {
  const raw = e?._status ?? e?.code ?? e?.statusCode ?? e?.response?.status ?? e?.status;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;

  return Number.isFinite(n) ? n : undefined;
}

/**
 * One cluster's AIJobs, or why there are none: null when the cluster does not serve the AIJob API
 * (404), so it is not a training cluster at all.
 */
export async function clusterJobs(store: any, id: string, name: string): Promise<TrainingCluster | null> {
  try {
    const res = await store.dispatch('rancher/request', { url: `/k8s/clusters/${ encodeURIComponent(id) }${ AIJOB_LIST_PATH }`, timeout: 15000 });
    const body = res?.data ?? res;

    return {
      id, name, jobs: Array.isArray(body?.items) ? body.items : [], error: ''
    };
  } catch (e: any) {
    const status = httpStatus(e);

    if (status === 404) {
      return null;
    }

    return {
      id, name, jobs: [], error: status === 403 ? 'You cannot list training jobs on this cluster' : `Could not read this cluster (${ status || e?.message || e })`
    };
  }
}

/** Every ready cluster that serves the AIJob API, with its jobs, in the cluster list's order. */
export async function trainingClusters(store: any): Promise<TrainingCluster[]> {
  const clusters = await getClusters(store);
  const found = await Promise.all(clusters.map((c) => clusterJobs(store, c.id, c.name || c.id)));

  return found.filter((c): c is TrainingCluster => !!c);
}

/** Whether a cluster has the named profile, so Deploy can offer it there. */
export async function hasProfile(store: any, clusterId: string, profile: string): Promise<boolean> {
  try {
    await store.dispatch('rancher/request', {
      url:     `/k8s/clusters/${ encodeURIComponent(clusterId) }/api/v1/namespaces/ai-profiles/configmaps/${ encodeURIComponent(profile) }`,
      timeout: 15000,
    });

    return true;
  } catch {
    return false;
  }
}

/** A cluster's GPUs: how many its nodes offer, and which models. */
export interface ClusterGpus { count: number; models: string[]; nodes?: NodeFacts[] }

export function gpusOfNodes(nodes: any[]): ClusterGpus {
  let count = 0;
  const models = new Set<string>();

  for (const n of nodes || []) {
    const g = parseInt(n?.status?.allocatable?.['nvidia.com/gpu'] || '0', 10) || 0;

    count += g;
    if (g && n?.metadata?.labels?.['nvidia.com/gpu.product']) {
      models.add(n.metadata.labels['nvidia.com/gpu.product']);
    }
  }

  return { count, models: [...models], nodes: nodeFacts(nodes || []) };
}

/** The GPUs a cluster's nodes offer, through Rancher's proxy; null when its nodes cannot be read. */
export async function clusterGpus(store: any, clusterId: string): Promise<ClusterGpus | null> {
  try {
    const res = await store.dispatch('rancher/request', { url: `/k8s/clusters/${ encodeURIComponent(clusterId) }/api/v1/nodes`, timeout: 15000 });

    return gpusOfNodes((res?.data ?? res)?.items || []);
  } catch {
    return null;
  }
}

/**
 * Marks a downstream cluster for AI: AI Factory's Fleet HelmOp targets clusters carrying this label
 * and installs the training agent there (the AIJob controller, the training chart repository, the
 * default profiles). Fleet takes a cluster's labels from its management cluster object, so the label
 * is set there; a cluster Rancher provisions also gets it on its provisioning object, so the two
 * agree.
 */
export const AI_CLUSTER_LABEL = 'ai-factory.suse.com/enabled';

/** Set or clear a cluster's AI label: merge patches of its management cluster object (which Fleet
 * reads) and, where it has one, its provisioning object. */
export async function setAiEnabled(store: any, clusterId: string, prov: { namespace: string; name: string } | null, enabled: boolean): Promise<void> {
  const patch = {
    method:  'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    data:    { metadata: { labels: { [AI_CLUSTER_LABEL]: enabled ? 'true' : null } } },
  };

  await store.dispatch('rancher/request', { url: `/k8s/clusters/local/apis/management.cattle.io/v3/clusters/${ encodeURIComponent(clusterId) }`, ...patch });
  if (prov) {
    await store.dispatch('rancher/request', {
      url: `/k8s/clusters/local/apis/provisioning.cattle.io/v1/namespaces/${ encodeURIComponent(prov.namespace) }/clusters/${ encodeURIComponent(prov.name) }`, ...patch
    });
  }
}
