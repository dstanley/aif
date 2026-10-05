// The rows of AI Factory's Clusters page: each cluster, whether it is set up for AI and how, its GPUs,
// what runs there and how many AI projects it has. Pure, so the states are tested without a cluster.

import type { ClusterGpus, TrainingCluster } from './trainingclusters';
import { AI_CLUSTER_LABEL } from './trainingclusters';

export type AiClusterState =
  | 'management' // the local cluster: AI Factory itself runs here
  | 'enabled' // labelled for AI, and its training agent answers
  | 'enabling' // labelled for AI, its agent not answering yet
  | 'manual' // its agent answers, but it is not labelled (installed by hand)
  | 'off';

export interface AiClusterRow {
  id: string;
  name: string;
  state: AiClusterState;
  gpus: ClusterGpus | null;
  running: number;
  workloads: number;
  aiProjects: number;
  /** the provisioning object the AI label is set on; null for a cluster Rancher has none for */
  provisioning: { namespace: string; name: string } | null;
}

export interface AiClusterInput {
  clusters: { id: string; name: string }[];
  training: TrainingCluster[];
  provisioning: any[];
  aiProjects: any[];
  workloads: any[];
  gpus: Record<string, ClusterGpus | null>;
  /** how many of a cluster's jobs are running */
  count: (jobs: any[]) => number;
}

const ORDER: Record<AiClusterState, number> = {
  management: 0, enabled: 1, manual: 1, enabling: 2, off: 3
};

export function aiClusterRows(i: AiClusterInput): AiClusterRow[] {
  const trainingById = new Map(i.training.map((t) => [t.id, t]));
  const provById = new Map((i.provisioning || []).filter((p) => p?.status?.clusterName).map((p) => [p.status.clusterName, p]));

  return i.clusters.map((c) => {
    const t = trainingById.get(c.id);
    const prov = provById.get(c.id);
    const labelled = prov?.metadata?.labels?.[AI_CLUSTER_LABEL] === 'true';
    let state: AiClusterState;

    if (c.id === 'local') {
      state = 'management';
    } else if (labelled) {
      state = t ? 'enabled' : 'enabling';
    } else {
      state = t ? 'manual' : 'off';
    }

    return {
      id:           c.id,
      name:         c.name || c.id,
      state,
      gpus:         i.gpus[c.id] ?? null,
      running:      t ? i.count(t.jobs) : 0,
      workloads:    (i.workloads || []).filter((w) => (w?.spec?.targetClusters || []).includes(c.id)).length,
      aiProjects:   (i.aiProjects || []).filter((p) => p?.metadata?.namespace === c.id).length,
      provisioning: prov && c.id !== 'local' ? { namespace: prov.metadata.namespace, name: prov.metadata.name } : null,
    };
  }).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}
