// The rows of AI Factory's Clusters page: each cluster, whether it is set up for AI and how, its GPUs,
// what runs there and how many AI projects it has. Pure, so the states are tested without a cluster.

import type { ClusterGpus, TrainingCluster } from './trainingclusters';
import { AI_CLUSTER_LABEL } from './trainingclusters';

export type AiClusterState =
  | 'management' // the local cluster: AI Factory itself runs here
  | 'enabled' // labelled for AI, and its training agent answers
  | 'enabling' // labelled for AI, its agent not answering yet
  | 'noagent' // labelled for AI, but AI Factory installs no agent (its aiClusters setting is off)
  | 'manual' // its agent answers, but it is not labelled (installed by hand)
  | 'off';

/** The status the page shows: what a person needs to know about a cluster at a glance. */
export type AiClusterStatus = 'ready' | 'installing' | 'attention' | 'off';

/** What AI Factory can see of an install on one cluster, for the status panel. */
export interface AiClusterInstall {
  /** whether AI Factory's training-agent HelmOp exists (undefined: Fleet's HelmOp type is not served) */
  installer?: boolean;
  /** when the cluster's Fleet agent last checked in, and whether that is too long ago */
  fleetLastSeen?: string;
  fleetStale: boolean;
  /** the agent bundle's deployment on this cluster, as Fleet reports it */
  bundle?: { state: string; message: string; notReady: string[] };
  /** the training agent answers (the cluster serves the AIJob API) */
  answers: boolean;
}

export interface AiClusterRow {
  id: string;
  name: string;
  state: AiClusterState;
  status: AiClusterStatus;
  install: AiClusterInstall;
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
  /** management.cattle.io clusters: their labels are the ones Fleet targets */
  management?: any[];
  /** whether AI Factory's training-agent HelmOp exists; false when aiClusters is off */
  installer?: boolean;
  aiProjects: any[];
  workloads: any[];
  gpus: Record<string, ClusterGpus | null>;
  /** how many of a cluster's jobs are running */
  count: (jobs: any[]) => number;
  /** fleet.cattle.io clusters (fleet-default): when each cluster's Fleet agent last checked in */
  fleetClusters?: any[];
  /** the training agent bundle's deployments, one per cluster (fleet.cattle.io BundleDeployments) */
  agentBundles?: any[];
  now?: number;
}

/** The Fleet bundle that installs the training agent (the operator chart's HelmOp). */
export const AGENT_BUNDLE = 'aif-operator-cluster-agent';

// A Fleet agent checks in every 15 minutes; an hour without one means it cannot reach Rancher.
const STALE_MS = 60 * 60 * 1000;
const BAD_BUNDLE = new Set(['ErrApplied', 'Error', 'Modified', 'OutOfSync']);

/** The status shown for a state, given what the install looks like. */
export function statusOf(state: AiClusterState, install: AiClusterInstall): AiClusterStatus {
  if (state === 'management' || state === 'enabled' || state === 'manual') {
    return 'ready';
  }
  if (state === 'off') {
    return 'off';
  }
  if (state === 'noagent' || install.fleetStale || (install.bundle && BAD_BUNDLE.has(install.bundle.state))) {
    return 'attention';
  }

  return 'installing';
}

/** "NVIDIA-RTX-A2000-12GB" as people say it: "RTX A2000 12 GB". */
export function gpuName(model: string): string {
  return model.replace(/^NVIDIA[- ]/i, '').replace(/-/g, ' ').replace(/(\d+)\s*GB$/i, '$1 GB').trim();
}

/** "1 × RTX A2000 12 GB", or "" when the cluster has no GPUs (or they are not known). */
export function gpuCapacity(g: ClusterGpus | null): string {
  if (!g || !g.count) {
    return '';
  }

  return g.models.length ? `${ g.count } × ${ g.models.map(gpuName).join(', ') }` : `${ g.count } GPU${ g.count === 1 ? '' : 's' }`;
}

export interface InstallStep { name: string; ok: boolean | null; detail: string }

/** The install of the training agent on a cluster, step by step: done (true), stuck (false), pending (null). */
export function installSteps(row: AiClusterRow, ago: (iso: string) => string): InstallStep[] {
  const i = row.install;
  const b = i.bundle;
  const steps: InstallStep[] = [
    { name: 'Requested', ok: row.state !== 'off', detail: row.state === 'manual' ? 'installed by hand, not through AI Factory' : 'the cluster is labelled for AI' },
    {
      name:   'AI Factory installer',
      ok:     i.installer === undefined ? null : i.installer,
      detail: i.installer === false ? "AI Factory's aiClusters setting is off, so nothing installs the agent" : i.installer ? 'the training agent is deployed through Fleet' : 'Fleet HelmOps are not available',
    },
    {
      name:   'Fleet agent on the cluster',
      ok:     i.fleetLastSeen ? !i.fleetStale : null,
      detail: i.fleetLastSeen ? `${ i.fleetStale ? 'last checked in' : 'checked in' } ${ ago(i.fleetLastSeen) }${ i.fleetStale ? ': it cannot reach Rancher' : '' }` : 'not reported yet',
    },
    {
      name:   'Training agent installed',
      ok:     b ? (b.state === 'Ready' ? true : BAD_BUNDLE.has(b.state) ? false : null) : null,
      detail: b ? [b.state, b.message, ...b.notReady].filter(Boolean).join(' · ') : 'waiting for Fleet to deliver it',
    },
    { name: 'Training agent answers', ok: i.answers ? true : null, detail: i.answers ? 'the cluster serves the AIJob API' : 'not yet' },
  ];

  return steps;
}

const ORDER: Record<AiClusterState, number> = {
  management: 0, enabled: 1, manual: 1, enabling: 2, noagent: 2, off: 3
};

export function aiClusterRows(i: AiClusterInput): AiClusterRow[] {
  const trainingById = new Map(i.training.map((t) => [t.id, t]));
  const provById = new Map((i.provisioning || []).filter((p) => p?.status?.clusterName).map((p) => [p.status.clusterName, p]));
  const mgmtById = new Map((i.management || []).map((m) => [m?.metadata?.name || m?.id, m]));
  const fleetById = new Map((i.fleetClusters || []).map((f) => [f?.metadata?.name, f]));
  // only the training agent's bundle: a cluster has others (an endpoint's, Fleet's own)
  const bundleById = new Map((i.agentBundles || [])
    .filter((b) => b?.metadata?.labels?.['fleet.cattle.io/bundle-name'] === AGENT_BUNDLE)
    .map((b) => [b?.metadata?.labels?.['fleet.cattle.io/cluster'], b]));
  const now = i.now ?? Date.now();

  return i.clusters.map((c) => {
    const t = trainingById.get(c.id);
    const prov = provById.get(c.id);
    const labelled = [prov, mgmtById.get(c.id)].some((o) => o?.metadata?.labels?.[AI_CLUSTER_LABEL] === 'true');
    let state: AiClusterState;

    if (c.id === 'local') {
      state = 'management';
    } else if (labelled) {
      state = t ? 'enabled' : i.installer === false ? 'noagent' : 'enabling';
    } else {
      state = t ? 'manual' : 'off';
    }

    const seen = fleetById.get(c.id)?.status?.agent?.lastSeen as string | undefined;
    const bd = bundleById.get(c.id);
    const install: AiClusterInstall = {
      installer:     i.installer,
      fleetLastSeen: seen,
      fleetStale:    !!seen && now - Date.parse(seen) > STALE_MS,
      bundle:        bd ? {
        state:    String(bd.status?.display?.state || 'Pending'),
        message:  String(bd.status?.display?.message || ''),
        notReady: (bd.status?.nonReadyStatus || []).map((n: any) => `${ n.kind } ${ n.name }${ n.summary?.message?.length ? `: ${ n.summary.message.join('; ') }` : '' }`),
      } : undefined,
      answers: !!t,
    };

    return {
      id:           c.id,
      name:         c.name || c.id,
      state,
      status:       statusOf(state, install),
      install,
      gpus:         i.gpus[c.id] ?? null,
      running:      t ? i.count(t.jobs) : 0,
      workloads:    (i.workloads || []).filter((w) => (w?.spec?.targetClusters || []).includes(c.id)).length,
      aiProjects:   (i.aiProjects || []).filter((p) => p?.metadata?.namespace === c.id).length,
      provisioning: prov && c.id !== 'local' ? { namespace: prov.metadata.namespace, name: prov.metadata.name } : null,
    };
  }).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}
