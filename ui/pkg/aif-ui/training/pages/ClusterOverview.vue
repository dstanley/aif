<script lang="ts" setup>
// A cluster's AI Training overview: what runs on this cluster's GPUs. Its capacity (GPUs and GPU
// memory, allocated and free), its projects and their entitlements, and its training runs, the
// active ones first. Everything is read from this cluster, with the user's own RBAC.
import { computed, getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
import Banner from '@components/Banner/Banner.vue';
import Loading from '@shell/components/Loading';
import GpuCapacityPanel from '../components/GpuCapacityPanel.vue';
import ProjectsPanel from '../components/ProjectsPanel.vue';
import { BadgeState } from '@components/BadgeState';
import { loadOverview } from '../overview';
import type { Overview } from '../overview';
import { AIJOB_TYPE } from '../aijob';
import { loadClusterLabel } from '../cluster';
import { trainingLink } from '../section';
import { jobRows, jobCounts } from '../clusteroverview';
import type { JobRow } from '../clusteroverview';

const vm = getCurrentInstance()!.proxy as any;
const store = vm.$store;
const cluster = String(vm.$route.params.cluster);

const loading = ref(true);
const error = ref('');
const clusterName = ref(cluster);
const overview = ref<Overview | null>(null);
const jobs = ref<any[]>([]);
const hasAIJobs = ref(true);

const rows = computed<JobRow[]>(() => jobRows(jobs.value));
const counts = computed(() => jobCounts(jobs.value));
const catalogRoute = computed(() => trainingLink(vm.$route, 'catalog'));
const jobsRoute = computed(() => trainingLink(vm.$route, 'jobs'));
const projectsRoute = computed(() => trainingLink(vm.$route, 'projects'));

async function refresh() {
  error.value = '';
  try {
    hasAIJobs.value = !!store.getters['cluster/schemaFor'](AIJOB_TYPE);
    const [o, j] = await Promise.all([
      loadOverview(store, cluster),
      hasAIJobs.value ? store.dispatch('cluster/findAll', { type: AIJOB_TYPE, opt: { force: true } }) : Promise.resolve([]),
    ]);

    overview.value = o;
    jobs.value = j || [];
  } catch (e: any) {
    error.value = `Could not read this cluster: ${ e?.message || e }`;
  } finally {
    loading.value = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 15000); // runs are short; a stale view is the thing to avoid
  loadClusterLabel(store, cluster).then((l: string) => {
    clusterName.value = l;
  });
});
onUnmounted(() => timer && clearInterval(timer));
</script>

<template>
  <main class="cluster-overview">
    <header class="co-header">
      <div>
        <h1>AI Training</h1>
        <p class="text-muted">
          {{ clusterName }}: GPU capacity, projects and the training runs on this cluster
        </p>
      </div>
      <div class="co-actions">
        <router-link
          :to="jobsRoute"
          class="btn role-secondary"
        >
          All jobs
        </router-link>
        <router-link
          :to="catalogRoute"
          class="btn role-primary"
        >
          Deploy
        </router-link>
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
        v-if="!hasAIJobs"
        color="warning"
        label="This cluster does not serve the AIJob API, or you cannot read it: training runs are not listed. Install the AI Factory operator's AIJob controller here."
      />

      <div class="co-counts">
        <div class="co-count">
          <span class="co-num">{{ counts.running }}</span><span class="text-muted">Running</span>
        </div>
        <div class="co-count">
          <span class="co-num">{{ counts.queued }}</span><span class="text-muted">Queued or pending</span>
        </div>
        <div class="co-count">
          <span class="co-num">{{ counts.succeeded }}</span><span class="text-muted">Succeeded</span>
        </div>
        <div class="co-count">
          <span :class="['co-num', { 'text-error': counts.failed }]">{{ counts.failed }}</span><span class="text-muted">Failed or cancelled</span>
        </div>
      </div>

      <div class="co-grid">
        <section class="co-panel co-jobs">
          <div class="co-panel-header">
            <h3>Training runs</h3>
            <router-link :to="jobsRoute">
              View all →
            </router-link>
          </div>
          <p
            v-if="!rows.length"
            class="text-muted"
          >
            No training runs on this cluster yet.
            <router-link :to="catalogRoute">
              Deploy one from the Catalog.
            </router-link>
          </p>
          <table
            v-else
            class="co-table"
          >
            <thead>
              <tr>
                <th>Run</th><th>Namespace</th><th>Phase</th><th>GPUs</th><th>Node</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in rows"
                :key="r.key"
              >
                <td>
                  <router-link :to="trainingLink($route, 'jobs', { q: r.name })">
                    {{ r.title }}
                  </router-link>
                  <div class="text-muted co-sub">
                    {{ r.name }}<template v-if="r.profile">
                      · {{ r.profile }}
                    </template>
                  </div>
                </td>
                <td>{{ r.namespace }}</td>
                <td>
                  <BadgeState
                    :color="r.color"
                    :label="r.phase"
                  />
                </td>
                <td>{{ r.gpus }}</td>
                <td>{{ r.nodes }}</td>
                <td>{{ r.result }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div class="co-side">
          <section class="co-panel">
            <GpuCapacityPanel :summary="overview ? overview.capacity : null" />
          </section>
          <section class="co-panel">
            <div class="co-panel-header">
              <h3>Projects</h3>
              <router-link :to="projectsRoute">
                Manage →
              </router-link>
            </div>
            <ProjectsPanel :projects="overview ? overview.projects : []" />
          </section>
        </div>
      </div>
    </template>
  </main>
</template>

<style lang="scss" scoped>
.cluster-overview { padding: 20px; }
.co-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.co-header p { margin: 4px 0 0; }
.co-actions { display: flex; gap: 8px; }
.co-counts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.co-count { border: 1px solid var(--border); border-radius: var(--border-radius); padding: 12px 16px; display: flex; flex-direction: column; }
.co-num { font-size: 24px; font-weight: 600; }
.co-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; align-items: start; }
.co-side { display: flex; flex-direction: column; gap: 16px; }
.co-panel { border: 1px solid var(--border); border-radius: var(--border-radius); padding: 16px; }
.co-panel-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
.co-panel-header h3 { margin: 0; }
.co-table { width: 100%; border-collapse: collapse; }
.co-table th, .co-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.co-sub { font-size: 12px; }
</style>
