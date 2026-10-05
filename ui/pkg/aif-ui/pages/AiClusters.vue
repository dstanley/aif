<script lang="ts" setup>
// AI Factory's landing page: the clusters, and which of them are set up for AI. Everything a user
// runs (jobs, workloads, projects and quotas) is in each cluster's AI Training section; this page
// says where those are, how many GPUs each cluster has and what is active there, and enables AI
// on a cluster: AI Factory then installs its training agent there through Fleet. The registries
// and their credentials are configured once, under Settings, and reach each AI project as a pull
// secret.
import { computed, getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
import { BadgeState } from '@components/BadgeState';
import Banner from '@components/Banner/Banner.vue';
import Loading from '@shell/components/Loading';
import { getClusters } from '../services/cluster-service';
import type { ClusterInfo } from '../types/rancher-types';
import { listAIWorkloads } from '../utils/operator-api';
import { checkOperatorConnection, getConnectionError } from '../utils/operator-config';
import {
  AI_CLUSTER_LABEL, ClusterGpus, clusterGpus, setAiEnabled, trainingClusters
} from '../training/trainingclusters';
import type { TrainingCluster } from '../training/trainingclusters';
import { jobCounts } from '../training/clusteroverview';
import { isAiProject } from '../training/projects';
import { CLUSTER_PAGES, CLUSTER_PRODUCT } from '../training/section';
import { PRODUCT, PAGE_TYPES } from '../config/suseai';
import { aiClusterRows } from '../training/aiclusters';
import type { AiClusterRow } from '../training/aiclusters';

const vm = getCurrentInstance()!.proxy as any;
const store = vm.$store;

const loading = ref(true);
const error = ref('');
const notice = ref('');
const busy = ref('');
const rows = ref<AiClusterRow[]>([]);

const settingsRoute = { name: `c-cluster-${ PRODUCT }-${ PAGE_TYPES.SETTINGS }`, params: { cluster: 'local' } };
const clusterRoute = (id: string) => ({ name: `c-cluster-${ CLUSTER_PRODUCT }-${ CLUSTER_PAGES.OVERVIEW }`, params: { cluster: id } });
const totals = computed(() => ({
  enabled: rows.value.filter((r) => r.state === 'enabled' || r.state === 'management').length,
  gpus:    rows.value.reduce((n, r) => n + (r.gpus?.count || 0), 0),
  running: rows.value.reduce((n, r) => n + r.running, 0),
}));

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

async function refresh() {
  try {
    await checkOperatorConnection();
    const [clusters, training, provs, projects, workloads] = await Promise.all([
      safe(getClusters(store), [] as ClusterInfo[]),
      safe(trainingClusters(store), [] as TrainingCluster[]),
      safe(store.dispatch('management/findAll', { type: 'provisioning.cattle.io.cluster', opt: { force: true } }), [] as any[]),
      safe(store.dispatch('management/findAll', { type: 'management.cattle.io.project', opt: { force: true } }), [] as any[]),
      getConnectionError() ? Promise.resolve({ items: [] as any[] }) : safe(listAIWorkloads(), { items: [] as any[] }),
    ]);
    const gpus = await Promise.all(clusters.map((c) => clusterGpus(store, c.id)));
    const gpuOf: Record<string, ClusterGpus | null> = {};

    clusters.forEach((c, i) => {
      gpuOf[c.id] = gpus[i];
    });
    rows.value = aiClusterRows({
      clusters,
      training,
      provisioning: provs || [],
      aiProjects:   (projects || []).filter(isAiProject),
      workloads:    workloads?.items || [],
      gpus:         gpuOf,
      count:        (jobs: any[]) => jobCounts(jobs).running,
    });
    error.value = '';
  } catch (e: any) {
    error.value = `Could not list the clusters: ${ e?.message || e }`;
  } finally {
    loading.value = false;
  }
}

async function toggle(r: AiClusterRow, enabled: boolean) {
  if (!r.provisioning) {
    return;
  }
  if (!enabled && !window.confirm(`Disable AI on ${ r.name }? AI Factory removes its training agent from the cluster; job records stay until the agent is reinstalled or they are deleted.`)) {
    return;
  }
  busy.value = r.id;
  try {
    await setAiEnabled(store, r.provisioning, enabled);
    notice.value = enabled ? `AI is being enabled on ${ r.name }: AI Factory installs its training agent there through Fleet. This takes a minute or two.` : `AI is being disabled on ${ r.name }.`;
    await refresh();
  } catch (e: any) {
    error.value = `Could not change ${ r.name }: ${ e?.message || e?.data?.message || e }`;
  } finally {
    busy.value = '';
  }
}

const badge: Record<AiClusterRow['state'], { color: string; label: string }> = {
  management: { color: 'bg-info', label: 'AI Factory' },
  enabled:    { color: 'bg-success', label: 'AI-enabled' },
  enabling:   { color: 'bg-warning', label: 'Enabling…' },
  manual:     { color: 'bg-success', label: 'AI-enabled (installed by hand)' },
  off:        { color: 'bg-darker', label: 'Not enabled' },
};

let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 30000);
});
onUnmounted(() => timer && clearInterval(timer));
</script>

<template>
  <main class="ai-clusters">
    <header class="ac-header">
      <div>
        <h1>Clusters</h1>
        <p class="text-muted">
          Where AI runs. Open a cluster's AI Training section to run jobs, deploy workloads and manage its projects and quotas.
          Registries and credentials are configured once, under <router-link :to="settingsRoute">
            Settings
          </router-link>, and reach each AI project as the pull secret <code>suse-ai-pull-combined</code>.
        </p>
      </div>
    </header>

    <Loading v-if="loading" />
    <template v-else>
      <Banner
        v-if="error"
        color="error"
        :label="error"
      />
      <Banner
        v-if="notice"
        color="info"
        :label="notice"
      />

      <div class="ac-counts">
        <span><b>{{ totals.enabled }}</b> AI cluster{{ totals.enabled === 1 ? '' : 's' }}</span>
        <span><b>{{ totals.gpus }}</b> GPUs</span>
        <span><b>{{ totals.running }}</b> jobs running</span>
      </div>

      <table class="ac-table">
        <thead>
          <tr>
            <th>Cluster</th><th>AI</th><th>GPUs</th><th>Jobs running</th><th>Workloads</th><th>AI projects</th><th />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in rows"
            :key="r.id"
          >
            <td>
              <router-link
                v-if="r.state !== 'off' && r.state !== 'enabling'"
                :to="clusterRoute(r.id)"
              >
                {{ r.name }}
              </router-link>
              <span v-else>{{ r.name }}</span>
            </td>
            <td>
              <BadgeState
                :color="badge[r.state].color"
                :label="badge[r.state].label"
              />
            </td>
            <td>
              <template v-if="r.gpus">
                {{ r.gpus.count || '–' }}<span
                  v-if="r.gpus.models.length"
                  class="text-muted"
                > × {{ r.gpus.models.join(', ') }}</span>
              </template>
              <span
                v-else
                class="text-muted"
              >unknown</span>
            </td>
            <td>{{ r.state === 'off' ? '–' : r.running }}</td>
            <td>{{ r.workloads || '–' }}</td>
            <td>{{ r.aiProjects || '–' }}</td>
            <td class="ac-actions">
              <router-link
                v-if="r.state !== 'off' && r.state !== 'enabling'"
                :to="clusterRoute(r.id)"
                class="btn btn-sm role-secondary"
              >
                Open
              </router-link>
              <button
                v-if="r.state === 'off' && r.provisioning"
                type="button"
                class="btn btn-sm role-primary"
                :disabled="busy === r.id"
                @click="toggle(r, true)"
              >
                Enable AI
              </button>
              <button
                v-if="(r.state === 'enabled' || r.state === 'enabling') && r.provisioning"
                type="button"
                class="btn btn-sm role-link"
                :disabled="busy === r.id"
                @click="toggle(r, false)"
              >
                Disable
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="text-muted ac-foot">
        Enable AI labels the cluster <code>{{ AI_CLUSTER_LABEL }}=true</code>; AI Factory's Fleet HelmOp installs the training agent (the AIJob controller, the training chart repository and the default profiles) on every cluster with that label.
      </p>
    </template>
  </main>
</template>

<style lang="scss" scoped>
.ai-clusters { padding: 20px; }
.ac-header p { margin: 4px 0 16px; max-width: 900px; }
.ac-counts { display: flex; gap: 24px; margin-bottom: 12px; }
.ac-table { width: 100%; border-collapse: collapse; }
.ac-table th, .ac-table td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.ac-actions { text-align: right; white-space: nowrap; display: flex; gap: 8px; justify-content: flex-end; }
.ac-foot { margin-top: 12px; font-size: 12px; }
</style>
