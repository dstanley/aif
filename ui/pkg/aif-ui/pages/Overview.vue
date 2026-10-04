<script lang="ts" setup>
import { ref, computed, onMounted, onUnmounted, getCurrentInstance } from 'vue';
import GpuCapacityPanel from '../training/components/GpuCapacityPanel.vue';
import ProjectsPanel from '../training/components/ProjectsPanel.vue';
import { loadOverview } from '../training/overview';
import type { Overview } from '../training/overview';
import { Banner }    from '@components/Banner';
import { BadgeState } from '@components/BadgeState';
import CountBox      from '@shell/components/CountBox';
import Loading       from '@shell/components/Loading';
import { checkOperatorConnection, getConnectionError } from '../utils/operator-config';
import OperatorErrorBanner from '../components/OperatorErrorBanner.vue';
import { listAIWorkloads, listAIJobs } from '../utils/operator-api';
import { listBlueprints, groupBlueprintsByFamily, latestVersion } from '../utils/blueprint-api';
import { phaseBadgeColor, phaseBadgeIcon } from '../utils/workload-status';
import type { AIWorkload } from '../types/aiworkload-types';
import type { Blueprint }                   from '../types/blueprint-types';
import { PRODUCT, PAGE_TYPES, MANAGEMENT_CLUSTER } from '../config/suseai';
import ClusterChips from '../formatters/ClusterChips.vue';
import { getClusters } from '../services/cluster-service';
import type { ClusterInfo } from '../types/rancher-types';
import { fetchManagedRepos } from '../services/app-collection';
import type { ManagedRepo } from '../services/app-collection';
import { requestErrorMessage } from '../services/rancher-token';
import RepositoryHealthBanner from './components/RepositoryHealthBanner.vue';

const vm      = getCurrentInstance()!.proxy as any;
const router  = vm.$router;
const route   = vm.$route;
const cluster = (route?.params?.cluster as string) || '_';

const loading         = ref(true);
const error           = ref<string | null>(null);
const operatorError   = ref<string | null>(null);
const workloads  = ref<AIWorkload[]>([]);
const blueprints = ref<Blueprint[]>([]);
const clusters   = ref<ClusterInfo[]>([]);
const repositories = ref<ManagedRepo[]>([]);
const repositoryError = ref('');
// Training runs (AIJobs), and GPU capacity and projects from the local cluster, where they run
const aiJobs     = ref<any[]>([]);
const overview   = ref<Overview | null>(null);
const deployOpen = ref(false);
const FINISHED   = ['Succeeded', 'Failed', 'Cancelled'];

// ── Computed stats ─────────────────────────────────────────────────────────────
// Workloads are what is deployed or running now: AIWorkloads, and training runs that have not finished.
const activeJobs       = computed(() => aiJobs.value.filter(j => !FINISHED.includes(j.status?.phase)));
const totalWorkloads   = computed(() => workloads.value.length + activeJobs.value.length);
const runningWorkloads = computed(() => workloads.value.filter(w => w.status?.phase === 'Running').length
  + aiJobs.value.filter(j => j.status?.phase === 'Running').length);
const projectCount     = computed(() => overview.value?.projects.length ?? 0);
const degradedWorkloads = computed(() => workloads.value.filter(w => w.status?.phase === 'Degraded').length);
const failedWorkloads  = computed(() => workloads.value.filter(w => w.status?.phase === 'Failed').length);
const issueWorkloads   = computed(() => degradedWorkloads.value + failedWorkloads.value);

interface RecentItem { key: string; name: string; phase: string; color: string; icon: string; type: string; detail: string; clusters: string[] | null; created: string }

// A training run's badge. Its phases are not an AIWorkload's: a finished run is Succeeded,
// Failed or Cancelled, and only Running and Failed carry an icon.
const JOB_BADGE: Record<string, { color: string; icon: string }> = {
  Running:   { color: 'bg-success', icon: 'icon-checkmark' },
  Succeeded: { color: 'bg-success', icon: '' },
  Failed:    { color: 'bg-error', icon: 'icon-x' },
};

// Most recent 5 workloads and training runs, newest first
const recentWorkloads = computed<RecentItem[]>(() => [
  ...workloads.value.map((w): RecentItem => ({
    key:      `wl/${ w.metadata.namespace }/${ w.metadata.name }`,
    name:     w.spec.displayName || w.metadata.name,
    phase:    w.status?.phase || 'Pending',
    color:    phaseBadgeColor(w.status?.phase),
    icon:     phaseBadgeIcon(w.status?.phase),
    type:     w.spec.source.sourceType === 'App' ? 'App' : 'Blueprint',
    detail:   workloadSourceLabel(w),
    clusters: w.spec.targetClusters || [],
    created:  (w.metadata as any).creationTimestamp || '',
  })),
  ...aiJobs.value.map((j): RecentItem => ({
    key:      `job/${ j.metadata.namespace }/${ j.metadata.name }`,
    name:     j.spec?.displayName || j.metadata.name,
    phase:    j.status?.phase || 'Pending',
    color:    JOB_BADGE[j.status?.phase]?.color || 'bg-info',
    icon:     JOB_BADGE[j.status?.phase]?.icon || '',
    type:     'Training',
    detail:   j.spec?.profile || j.spec?.source?.chartName || 'custom',
    clusters: null,
    created:  j.metadata.creationTimestamp || '',
  })),
].sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, 5));

// Active (non-deprecated) blueprint families with their latest version
const activeBlueprintList = computed(() => {
  const families = groupBlueprintsByFamily(blueprints.value);
  const result: { family: string; latest: Blueprint }[] = [];
  for (const [family, versions] of families.entries()) {
    const active = versions.filter(bp => !bp.spec.deprecated);
    if (active.length > 0) {
      result.push({ family, latest: latestVersion(active) });
    }
  }
  return result.slice(0, 5);
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function workloadSourceLabel(w: AIWorkload): string {
  if (w.spec.source.sourceType === 'App') return w.spec.source.app?.chartName || '—';
  return `${ w.spec.source.blueprint?.name || '—' } v${ w.spec.source.blueprint?.version || '' }`;
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function goTo(pageType: string, query?: Record<string, string>) {
  deployOpen.value = false;
  router.push({ name: `c-cluster-${ PRODUCT }-${ pageType }`, params: { cluster }, query });
}

// GPU capacity and projects need the local cluster's store; elsewhere the panels say so.
async function refreshOverview() {
  if (cluster !== MANAGEMENT_CLUSTER) {
    overview.value = null;

    return;
  }
  try {
    overview.value = await loadOverview(vm.$store, MANAGEMENT_CLUSTER);
  } catch {
    overview.value = null;
  }
}

async function refreshJobs() {
  try {
    aiJobs.value = (await listAIJobs()).items || [];
  } catch {
    aiJobs.value = []; // an operator without the AIJob API
  }
}

// ── Data loading ───────────────────────────────────────────────────────────────
async function refresh() {
  loading.value = true;
  error.value   = null;
  await checkOperatorConnection();
  operatorError.value = getConnectionError();
  if (operatorError.value) {
    loading.value = false;
    return;
  }
  try {
    const [wlResult, bpResult, clResult] = await Promise.all([
      listAIWorkloads(),
      listBlueprints().catch(() => ({ items: [] as Blueprint[] })),
      getClusters(vm.$store).catch(() => [] as ClusterInfo[]),
      refreshRepositoryHealth(),
      refreshJobs(),
      refreshOverview(),
    ]);
    workloads.value  = wlResult.items || [];
    blueprints.value = bpResult.items || [];
    clusters.value   = clResult;
  } catch (e: any) {
    error.value = e?.message || 'Failed to load overview data';
  } finally {
    loading.value = false;
  }
}

async function refreshRepositoryHealth() {
  try {
    repositories.value = await fetchManagedRepos(vm.$store);
    repositoryError.value = '';
  } catch (e) {
    repositories.value = [];
    repositoryError.value = requestErrorMessage(e);
  }
}

async function retryConnection() {
  loading.value = true;
  await checkOperatorConnection(true);
  operatorError.value = getConnectionError();
  if (!operatorError.value) await refresh();
  else loading.value = false;
}

async function silentRefresh() {
  if (loading.value) return;
  try {
    // GPU capacity and projects read every pod and node: every third tick (30s) is often enough
    ticks = (ticks + 1) % 3;
    const [wlResult] = await Promise.all([listAIWorkloads(), refreshRepositoryHealth(), refreshJobs(), ticks === 0 ? refreshOverview() : Promise.resolve()]);
    workloads.value = wlResult.items || [];
  } catch { /* ignore */ }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let ticks = 0;

onMounted(() => {
  refresh();
  pollTimer = setInterval(silentRefresh, 10_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <main class="main-layout">
    <div class="outlet">
      <header class="page-header">
        <h1>Overview</h1>
        <div class="header-actions">
          <div
            class="deploy-menu"
            @keydown.esc="deployOpen = false"
          >
            <button
              class="btn role-primary"
              type="button"
              :aria-expanded="deployOpen"
              @click="deployOpen = !deployOpen"
            >
              <i class="icon icon-plus" /> Deploy <i class="icon icon-chevron-down" />
            </button>
            <ul
              v-if="deployOpen"
              class="deploy-options"
            >
              <li>
                <button
                  type="button"
                  @click="goTo(PAGE_TYPES.CATALOG, { tab: 'training' })"
                >
                  Training job
                </button>
              </li>
              <li>
                <button
                  type="button"
                  @click="goTo(PAGE_TYPES.CATALOG, { tab: 'inference' })"
                >
                  Inference endpoint
                </button>
              </li>
              <li>
                <button
                  type="button"
                  @click="goTo(PAGE_TYPES.CATALOG, { tab: 'application' })"
                >
                  Application
                </button>
              </li>
            </ul>
          </div>
          <button
            class="btn role-secondary"
            :disabled="loading"
            type="button"
            @click="refresh"
          >
            <i
              v-if="loading"
              class="icon icon-spinner icon-spin"
            />
            <i
              v-else
              class="icon icon-refresh"
            />
            Refresh
          </button>
        </div>
      </header>

      <OperatorErrorBanner
        v-if="operatorError"
        :operator-error="operatorError"
        @retry="retryConnection"
      />

      <Banner
        v-if="error"
        color="error"
        class="mb-20"
      >
        {{ error }}
      </Banner>

      <Loading v-if="loading" />

      <template v-else-if="!operatorError">
        <RepositoryHealthBanner
          :repositories="repositories"
          :error="repositoryError"
          compact
        />
        <!-- ── Summary cards ─────────────────────────────────────────────── -->
        <section class="summary-grid">
          <CountBox
            name="Deployments"
            :count="totalWorkloads"
            primary-color-var="--sizzle-info"
            :clickable="true"
            @click="goTo(PAGE_TYPES.WORKLOADS)"
          />
          <CountBox
            name="Running"
            :count="runningWorkloads"
            primary-color-var="--sizzle-success"
            :clickable="true"
            @click="goTo(PAGE_TYPES.WORKLOADS)"
          />
          <CountBox
            name="With Issues"
            :count="issueWorkloads"
            primary-color-var="--sizzle-error"
            :clickable="true"
            @click="goTo(PAGE_TYPES.WORKLOADS)"
          />
          <CountBox
            name="Projects"
            :count="projectCount"
            primary-color-var="--sizzle-3"
            :clickable="true"
            @click="goTo(PAGE_TYPES.PROJECTS)"
          />
        </section>

        <!-- ── Two-column lower section ──────────────────────────────────── -->
        <div class="lower-grid">
          <!-- Recent Deployments -->
          <section class="panel">
            <div class="panel-header">
              <h3>Recent Deployments</h3>
              <button
                class="btn-link"
                type="button"
                @click="goTo(PAGE_TYPES.WORKLOADS)"
              >
                View all <i class="icon icon-chevron-right" />
              </button>
            </div>

            <div
              v-if="!recentWorkloads.length"
              class="panel-empty"
            >
              <i class="icon icon-folder-open" />
              No workloads deployed yet.
            </div>

            <table
              v-else
              class="overview-table"
            >
              <thead>
                <tr>
                  <th>State</th>
                  <th>Name</th>
                  <th>Type / Profile</th>
                  <th>Cluster</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="w in recentWorkloads"
                  :key="w.key"
                >
                  <td>
                    <BadgeState
                      :color="w.color"
                      :icon="w.icon"
                      :label="w.phase"
                    />
                  </td>
                  <td class="col-name">
                    {{ w.name }}
                  </td>
                  <td class="col-type">
                    {{ w.type }} · <code class="col-source">{{ w.detail }}</code>
                  </td>
                  <td class="col-cluster">
                    <span
                      v-if="!w.clusters"
                      class="text-muted"
                    >local</span>
                    <ClusterChips
                      v-else
                      :clusters="w.clusters"
                      :cluster-info="clusters"
                      :show-label="false"
                      :clickable="false"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <!-- GPU Capacity -->
          <section class="panel">
            <div class="panel-header">
              <h3>GPU Capacity</h3>
              <button
                class="btn-link"
                type="button"
                @click="goTo(PAGE_TYPES.PROJECTS)"
              >
                Projects <i class="icon icon-chevron-right" />
              </button>
            </div>
            <GpuCapacityPanel :summary="overview ? overview.capacity : null" />
          </section>

          <!-- Active Blueprints -->
          <section class="panel">
            <div class="panel-header">
              <h3>Active Blueprints</h3>
              <button
                class="btn-link"
                type="button"
                @click="goTo(PAGE_TYPES.CATALOG, { tab: 'application' })"
              >
                View all <i class="icon icon-chevron-right" />
              </button>
            </div>

            <div
              v-if="!activeBlueprintList.length"
              class="panel-empty"
            >
              <i class="icon icon-document" />
              No blueprints defined yet.
            </div>

            <ul
              v-else
              class="overview-list"
            >
              <li
                v-for="item in activeBlueprintList"
                :key="item.family"
              >
                <span class="col-name">{{ item.latest.spec.displayName }}</span>
                <span class="list-version">v{{ item.latest.spec.version }}</span>
              </li>
            </ul>
          </section>

          <!-- Projects -->
          <section class="panel">
            <div class="panel-header">
              <h3>Projects</h3>
              <button
                class="btn-link"
                type="button"
                @click="goTo(PAGE_TYPES.PROJECTS)"
              >
                View all <i class="icon icon-chevron-right" />
              </button>
            </div>
            <ProjectsPanel :projects="overview ? overview.projects : []" />
          </section>
        </div>
      </template>
    </div>
  </main>
</template>

<style lang="scss" scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;

  h1 { margin: 0; }
}

// ── Summary cards ──────────────────────────────────────────────────────────────
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;

  @media (max-width: 900px) {
    grid-template-columns: repeat(2, 1fr);
  }
}

// ── Lower two-column section ──────────────────────────────────────────────────
.lower-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 24px;

  @media (max-width: 800px) {
    grid-template-columns: 1fr;
  }
}

.panel {
  background: var(--body-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;

  h3 { margin: 0; font-size: 15px; font-weight: 600; }
}

.panel-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 14px;
  padding: 20px 0;

  .icon { font-size: 20px; opacity: 0.5; }
}

.btn-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: none;
  border: none;
  color: var(--primary);
  font-size: 13px;
  cursor: pointer;
  padding: 0;

  &:hover { text-decoration: underline; }
}

// ── Overview tables ────────────────────────────────────────────────────────────
.overview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th {
    text-align: left;
    padding: 6px 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }

  td {
    padding: 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  tr:last-child td { border-bottom: none; }

  tr:hover td { background: var(--sortable-table-accent-bg); }

  .col-name   { font-weight: 500; color: var(--body-text); }
  .col-source { color: var(--muted); font-size: 12px; font-family: monospace; }
}

.overview-list {
  list-style: none;
  margin: 0;
  padding: 0;

  li {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);

    &:last-child { border-bottom: 0; }
  }
}
.list-version { color: var(--muted); font-family: monospace; font-size: 12px; }
.col-type code { background: none; padding: 0; }
// ── Header actions ─────────────────────────────────────────────────────────────
.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.deploy-menu { position: relative; }
.deploy-options {
  position: absolute;
  right: 0;
  z-index: 20;
  min-width: 260px;
  margin: 4px 0 0;
  padding: 4px 0;
  list-style: none;
  background: var(--body-bg);
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);

  button {
    width: 100%;
    padding: 8px 14px;
    background: none;
    border: 0;
    text-align: left;
    color: var(--body-text);
    cursor: pointer;

    &:hover { background: var(--accent-btn); }
  }
}
</style>
