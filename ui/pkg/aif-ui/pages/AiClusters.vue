<script lang="ts" setup>
// AI Factory's Clusters page: which clusters support AI, whether they are healthy, and how to open or
// enable them. Everything a user runs is in each cluster's AI Training section; enabling AI on a
// cluster has AI Factory install its training agent there through Fleet, and the status panel shows
// that install step by step.
import { computed, getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
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
import { ago } from '../training/runs';
import { CLUSTER_PAGES, CLUSTER_PRODUCT } from '../training/section';
import { AGENT_BUNDLE, aiClusterRows, gpuCapacity, installSteps } from '../training/aiclusters';
import type { AiClusterRow, AiClusterStatus } from '../training/aiclusters';

const vm = getCurrentInstance()!.proxy as any;
const store = vm.$store;

const loading = ref(true);
const error = ref('');
const notice = ref('');
const busy = ref('');
const rows = ref<AiClusterRow[]>([]);
const openStatus = ref('');
const confirmDisable = ref('');

const clusterRoute = (id: string) => ({ name: `c-cluster-${ CLUSTER_PRODUCT }-${ CLUSTER_PAGES.OVERVIEW }`, params: { cluster: id } });
const totals = computed(() => ({
  ready:   rows.value.filter((r) => r.status === 'ready').length,
  all:     rows.value.length,
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

const served = (type: string) => !!store.getters['management/schemaFor'](type);
const all = (type: string) => safe(store.dispatch('management/findAll', { type, opt: { force: true } }), [] as any[]);

async function refresh() {
  try {
    await checkOperatorConnection();
    const [clusters, training, provs, mgmt, helmops, fleetClusters, bundles, projects, workloads] = await Promise.all([
      safe(getClusters(store), [] as ClusterInfo[]),
      safe(trainingClusters(store), [] as TrainingCluster[]),
      all('provisioning.cattle.io.cluster'),
      all('management.cattle.io.cluster'),
      // the training agent's HelmOp exists only when AI Factory runs with aiClusters on
      served('fleet.cattle.io.helmop') ? all('fleet.cattle.io.helmop') : Promise.resolve(null),
      served('fleet.cattle.io.cluster') ? all('fleet.cattle.io.cluster') : Promise.resolve([]),
      served('fleet.cattle.io.bundledeployment') ? safe(store.dispatch('management/findMatching', { type: 'fleet.cattle.io.bundledeployment', selector: `fleet.cattle.io/bundle-name=${ AGENT_BUNDLE }` }), [] as any[]) : Promise.resolve([]),
      all('management.cattle.io.project'),
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
      provisioning:  provs || [],
      management:    mgmt || [],
      installer:     helmops === null ? undefined : (helmops as any[]).some((h: any) => h?.metadata?.namespace === 'fleet-default' && h?.metadata?.name === AGENT_BUNDLE),
      fleetClusters: (fleetClusters || []).filter((f: any) => f?.metadata?.namespace === 'fleet-default'),
      agentBundles:  bundles || [],
      aiProjects:    (projects || []).filter(isAiProject),
      workloads:     workloads?.items || [],
      gpus:          gpuOf,
      count:         (jobs: any[]) => jobCounts(jobs).running,
    });
    error.value = '';
  } catch (e: any) {
    error.value = `Could not list the clusters: ${ e?.message || e }`;
  } finally {
    loading.value = false;
  }
}

async function setAi(r: AiClusterRow, enabled: boolean) {
  busy.value = r.id;
  confirmDisable.value = '';
  try {
    await setAiEnabled(store, r.id, r.provisioning, enabled);
    notice.value = enabled ? `Installing AI Factory's training agent on ${ r.name } through Fleet. This takes a minute or two; View status shows its progress.` : `Removing AI Factory's training agent from ${ r.name }. Job records stay until the agent is reinstalled or they are deleted.`;
    if (enabled) {
      openStatus.value = r.id;
    }
    await refresh();
  } catch (e: any) {
    error.value = `Could not change ${ r.name }: ${ e?.message || e?.data?.message || e }`;
  } finally {
    busy.value = '';
  }
}

const STATUS: Record<AiClusterStatus, { label: string; tone: string }> = {
  ready:      { label: 'Ready', tone: 'ok' },
  installing: { label: 'Installing', tone: 'warn' },
  attention:  { label: 'Attention required', tone: 'bad' },
  off:        { label: 'Not enabled', tone: 'off' },
};

const toggleStatus = (id: string) => {
  openStatus.value = openStatus.value === id ? '' : id;
  confirmDisable.value = '';
};

// one row's ⋮ menu open at a time; a click elsewhere closes it
const menuFor = ref('');
const closeMenu = () => {
  menuFor.value = '';
};
const canDisable = (r: AiClusterRow) => r.id !== 'local' && r.state !== 'manual' && r.status !== 'off';
const actions = (r: AiClusterRow) => [
  ...(r.status === 'ready' ? [{ key: 'open', label: 'Open' }] : []),
  // the management cluster runs AI Factory itself: nothing is installed there through Fleet
  ...(r.status === 'off' ? [{ key: 'enable', label: 'Enable AI' }] : r.state === 'management' ? [] : [{ key: 'status', label: openStatus.value === r.id ? 'Hide status' : 'View status' }]),
  ...(canDisable(r) ? [{ key: 'disable', label: 'Disable AI', danger: true }] : []),
];

function act(r: AiClusterRow, key: string) {
  menuFor.value = '';
  if (key === 'open') {
    vm.$router.push(clusterRoute(r.id));
  } else if (key === 'enable') {
    setAi(r, true);
  } else if (key === 'status') {
    toggleStatus(r.id);
  } else if (key === 'disable') {
    openStatus.value = r.id;
    confirmDisable.value = r.id;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 30000);
  document.addEventListener('click', closeMenu);
});
onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
  document.removeEventListener('click', closeMenu);
});
</script>

<template>
  <main class="ai-clusters">
    <header class="ac-header">
      <div>
        <h1>Clusters</h1>
        <p class="ac-lead">
          Manage AI capabilities across your Kubernetes clusters.
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

      <section
        class="ac-metrics"
        aria-label="Summary"
      >
        <div class="ac-metric">
          <div class="ac-metric-label">
            AI-enabled
          </div>
          <div class="ac-metric-value">
            {{ totals.ready }} / {{ totals.all }}
          </div>
        </div>
        <div class="ac-metric">
          <div class="ac-metric-label">
            GPUs
          </div>
          <div class="ac-metric-value">
            {{ totals.gpus }}
          </div>
        </div>
        <div class="ac-metric">
          <div class="ac-metric-label">
            Active jobs
          </div>
          <div class="ac-metric-value">
            {{ totals.running }}
          </div>
        </div>
      </section>

      <section class="ac-list">
        <div class="ac-list-header">
          <h2>Managed clusters</h2>
          <span class="ac-secondary">{{ totals.all }} cluster{{ totals.all === 1 ? '' : 's' }}</span>
        </div>

        <table class="ac-table">
          <thead>
            <tr>
              <th>Cluster</th>
              <th>Status</th>
              <th>GPU capacity</th>
              <th class="ac-num">
                Workloads
              </th>
              <th class="ac-num">
                Jobs
              </th>
              <th class="ac-action">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <template
              v-for="r in rows"
              :key="r.id"
            >
              <tr>
                <td class="ac-name">
                  <router-link
                    v-if="r.status === 'ready'"
                    :to="clusterRoute(r.id)"
                  >
                    {{ r.name }}
                  </router-link>
                  <template v-else>
                    {{ r.name }}
                  </template>
                  <span
                    v-if="r.state === 'manual'"
                    class="ac-secondary"
                  > · installed by hand</span>
                </td>
                <td>
                  <span :class="['ac-status', `ac-status-${ STATUS[r.status].tone }`]">{{ STATUS[r.status].label }}</span>
                </td>
                <td>{{ gpuCapacity(r.gpus) || '—' }}</td>
                <td class="ac-num">
                  {{ r.workloads || '—' }}
                </td>
                <td class="ac-num">
                  {{ r.status === 'off' ? '—' : r.running }}
                </td>
                <td class="ac-action">
                  <div
                    class="ac-menu"
                    @click.stop
                  >
                    <button
                      type="button"
                      class="ac-menu-button"
                      :aria-label="`Actions for ${ r.name }`"
                      :aria-expanded="menuFor === r.id"
                      :disabled="busy === r.id"
                      @click="menuFor = menuFor === r.id ? '' : r.id"
                    >
                      <i class="icon icon-actions" />
                    </button>
                    <ul
                      v-if="menuFor === r.id"
                      class="ac-menu-list"
                      role="menu"
                    >
                      <li
                        v-for="a in actions(r)"
                        :key="a.key"
                        role="none"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          :class="['ac-menu-item', { 'ac-menu-danger': a.danger }]"
                          @click="act(r, a.key)"
                        >
                          {{ a.label }}
                        </button>
                      </li>
                    </ul>
                  </div>
                </td>
              </tr>
              <tr
                v-if="openStatus === r.id"
                class="ac-detail"
              >
                <td colspan="6">
                  <ol class="ac-steps">
                    <li
                      v-for="s in installSteps(r, ago)"
                      :key="s.name"
                      :class="['ac-step', s.ok === true ? 'ac-step-ok' : s.ok === false ? 'ac-step-bad' : 'ac-step-wait']"
                    >
                      <span class="ac-step-mark">{{ s.ok === true ? '✓' : s.ok === false ? '!' : '…' }}</span>
                      <span class="ac-step-name">{{ s.name }}</span>
                      <span class="ac-secondary">{{ s.detail }}</span>
                    </li>
                  </ol>
                  <div
                    v-if="r.id !== 'local' && r.state !== 'manual'"
                    class="ac-detail-actions"
                  >
                    <template v-if="confirmDisable === r.id">
                      <span>Remove the training agent from {{ r.name }}? Job records stay until it is reinstalled or they are deleted.</span>
                      <button
                        type="button"
                        class="btn btn-sm role-primary bg-error"
                        :disabled="busy === r.id"
                        @click="setAi(r, false)"
                      >
                        Disable AI
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm role-secondary"
                        @click="confirmDisable = ''"
                      >
                        Cancel
                      </button>
                    </template>
                    <button
                      v-else
                      type="button"
                      class="ac-link ac-link-quiet"
                      @click="confirmDisable = r.id"
                    >
                      Disable AI on {{ r.name }}
                    </button>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>

        <details class="ac-help">
          <summary>
            AI enablement is managed through Rancher Fleet.
          </summary>
          <p>
            Enabling AI adds the <code>{{ AI_CLUSTER_LABEL }}=true</code> label to the cluster. Fleet then automatically deploys the AI Factory components, including the AIJob controller, training chart repository, and default profiles. Container registries and credentials are configured centrally under Settings.
          </p>
        </details>
      </section>
    </template>
  </main>
</template>

<style lang="scss" scoped>
// Primary text in the page's body colour; secondary text in the same colour, lighter, rather than
// the theme's tinted muted colour, so it stays neutral and readable in both themes.
.ai-clusters { padding: 20px; color: var(--body-text); font-size: 14px; line-height: 1.5; }
.ac-secondary { opacity: 0.7; }

.ac-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
.ac-header h1 { margin: 0; }
.ac-lead { margin: 4px 0 0; font-size: 15px; opacity: 0.8; }

.ac-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }
.ac-metric { padding: 14px 18px; border: 1px solid var(--border); border-radius: var(--border-radius); background: var(--box-bg); }
.ac-metric-label { font-size: 13px; opacity: 0.7; }
.ac-metric-value { font-size: 30px; font-weight: 600; line-height: 1.2; }

.ac-list-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.ac-list-header h2 { margin: 0; font-size: 18px; }

.ac-table { width: 100%; border-collapse: collapse; }
.ac-table th { text-align: left; font-size: 13px; font-weight: 600; padding: 10px 12px; background: var(--sortable-table-header-bg, var(--box-bg)); border-bottom: 1px solid var(--border); }
.ac-table td { text-align: left; padding: 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.ac-table .ac-num { text-align: left; width: 90px; }
.ac-table .ac-action { text-align: right; white-space: nowrap; width: 1%; }
.ac-name { font-weight: 600; }

.ac-status { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 13px; font-weight: 600; }
.ac-status-ok { background: var(--success-banner-bg); color: var(--success); }
.ac-status-warn { background: var(--warning-banner-bg); color: var(--warning); }
.ac-status-bad { background: var(--error-banner-bg); color: var(--error); }
.ac-status-off { background: var(--box-bg); color: var(--body-text); }

.ac-menu { position: relative; display: inline-block; }
.ac-menu-button { background: none; border: 1px solid transparent; border-radius: var(--border-radius); padding: 4px 8px; cursor: pointer; color: var(--body-text); }
.ac-menu-button:hover, .ac-menu-button[aria-expanded="true"] { border-color: var(--border); background: var(--box-bg); }
.ac-menu-list { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 160px; margin: 0; padding: 4px 0; list-style: none; text-align: left; background: var(--body-bg); border: 1px solid var(--border); border-radius: var(--border-radius); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); }
.ac-menu-item { display: block; width: 100%; padding: 6px 14px; background: none; border: 0; text-align: left; color: var(--body-text); font-size: 14px; cursor: pointer; }
.ac-menu-item:hover { background: var(--box-bg); }
.ac-menu-danger { color: var(--error); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.ac-link { background: none; border: 0; padding: 0; color: var(--link); font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; }
.ac-link:hover { text-decoration: underline; }
.ac-link:disabled { opacity: 0.5; cursor: default; }
.ac-link + .ac-link { margin-left: 16px; }
.ac-link-quiet { font-weight: normal; opacity: 0.8; }

.ac-detail td { background: var(--box-bg); }
.ac-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ac-step { display: grid; grid-template-columns: 20px 200px 1fr; gap: 8px; align-items: baseline; }
.ac-step-mark { font-weight: 700; text-align: center; }
.ac-step-ok .ac-step-mark { color: var(--success); }
.ac-step-bad .ac-step-mark, .ac-step-bad .ac-step-name { color: var(--error); }
.ac-step-wait .ac-step-mark { color: var(--warning); }
.ac-step-name { font-weight: 600; }
.ac-detail-actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }

.ac-help { margin-top: 14px; }
.ac-help summary { cursor: pointer; opacity: 0.8; }
.ac-help p { margin: 8px 0 0 22px; max-width: 900px; opacity: 0.8; }

@media (max-width: 800px) {
  .ac-metrics { grid-template-columns: 1fr; }
  .ac-step { grid-template-columns: 20px 1fr; }
  .ac-step .ac-secondary { grid-column: 2; }
}
</style>
