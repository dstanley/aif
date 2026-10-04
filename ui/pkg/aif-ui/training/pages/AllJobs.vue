<script lang="ts" setup>
// Jobs: the training and test runs on every cluster, in one list. Each run lives on its own cluster,
// read here through Rancher's cluster proxy with the user's identity; its row links into that
// cluster's AI Training section, where its pods, logs and results are. Persistent workloads
// (inference endpoints, applications) are on the Workloads page instead.
import { computed, getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
import { BadgeState } from '@components/BadgeState';
import Banner from '@components/Banner/Banner.vue';
import Loading from '@shell/components/Loading';
import { trainingClusters } from '../trainingclusters';
import type { TrainingCluster } from '../trainingclusters';
import { byActivity, jobCounts, jobRows } from '../clusteroverview';
import type { JobRow } from '../clusteroverview';
import { CLUSTER_PRODUCT, CLUSTER_PAGES } from '../section';
import { PRODUCT_NAME } from '../config';

const vm = getCurrentInstance()!.proxy as any;
const store = vm.$store;

const loading = ref(true);
const error = ref('');
const clusters = ref<TrainingCluster[]>([]);
const filter = ref({ text: '', cluster: '', active: false });

type Row = JobRow & { cluster: string; clusterName: string };

const rows = computed<Row[]>(() => clusters.value
  .flatMap((c) => jobRows(c.jobs, Number.MAX_SAFE_INTEGER).map((r) => ({ ...r, cluster: c.id, clusterName: c.name })))
  .sort(byActivity));
const shown = computed(() => {
  const q = filter.value.text.trim().toLowerCase();

  return rows.value.filter((r) => (!filter.value.cluster || r.cluster === filter.value.cluster) &&
    (!filter.value.active || r.active) &&
    (!q || `${ r.title } ${ r.name } ${ r.namespace } ${ r.profile } ${ r.clusterName }`.toLowerCase().includes(q)));
});
const counts = computed(() => jobCounts(clusters.value.flatMap((c) => c.jobs)));
const unreadable = computed(() => clusters.value.filter((c) => c.error));

const clusterRoute = (id: string, page: string, query: Record<string, string> = {}) => ({
  name: `c-cluster-${ CLUSTER_PRODUCT }-${ page }`, params: { cluster: id }, query
});
const runRoute = (r: Row) => clusterRoute(r.cluster, CLUSTER_PAGES.JOBS, { q: r.name });
const catalogRoute = computed(() => ({ name: `c-cluster-${ PRODUCT_NAME }-catalog`, params: { cluster: vm.$route.params.cluster }, query: { tab: 'training' } }));

async function refresh() {
  try {
    clusters.value = await trainingClusters(store);
    error.value = '';
  } catch (e: any) {
    error.value = `Could not list the clusters: ${ e?.message || e }`;
  } finally {
    loading.value = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 20000);
});
onUnmounted(() => timer && clearInterval(timer));
</script>

<template>
  <main class="all-jobs">
    <header class="aj-header">
      <div>
        <h1>Jobs</h1>
        <p class="text-muted">
          Training and test runs on every cluster. Open one to see its pods, logs and results on its cluster.
        </p>
      </div>
      <router-link
        :to="catalogRoute"
        class="btn role-primary"
      >
        Run a job
      </router-link>
    </header>

    <Loading v-if="loading" />
    <template v-else>
      <Banner
        v-if="error"
        color="error"
        :label="error"
      />
      <Banner
        v-for="c in unreadable"
        :key="c.id"
        color="warning"
        :label="`${ c.name }: ${ c.error }`"
      />
      <Banner
        v-if="!clusters.length && !error"
        color="info"
        label="No cluster serves the AIJob API yet. Install the AI Factory operator's AIJob controller on a GPU cluster to run jobs there."
      />

      <div class="aj-counts">
        <span><b>{{ counts.running }}</b> running</span>
        <span><b>{{ counts.queued }}</b> queued or pending</span>
        <span><b>{{ counts.succeeded }}</b> succeeded</span>
        <span><b :class="{ 'text-error': counts.failed }">{{ counts.failed }}</b> failed or cancelled</span>
        <span class="text-muted">on {{ clusters.length }} training cluster{{ clusters.length === 1 ? '' : 's' }}:
          <template
            v-for="(c, i) in clusters"
            :key="c.id"
          >
            <router-link :to="clusterRoute(c.id, CLUSTER_PAGES.OVERVIEW)">{{ c.name }}</router-link>{{ i < clusters.length - 1 ? ', ' : '' }}
          </template>
        </span>
      </div>

      <div class="aj-toolbar">
        <input
          v-model="filter.text"
          type="search"
          class="input-sm"
          placeholder="Search jobs"
          aria-label="Search jobs"
        >
        <select
          v-model="filter.cluster"
          class="form-control-sm"
          aria-label="Cluster"
        >
          <option value="">
            All clusters
          </option>
          <option
            v-for="c in clusters"
            :key="c.id"
            :value="c.id"
          >
            {{ c.name }}
          </option>
        </select>
        <label class="aj-check"><input
          v-model="filter.active"
          type="checkbox"
        > Active only</label>
      </div>

      <p
        v-if="!shown.length"
        class="text-muted"
      >
        No jobs{{ filter.text || filter.cluster || filter.active ? ' match the filter' : ' yet' }}.
      </p>
      <table
        v-else
        class="aj-table"
      >
        <thead>
          <tr>
            <th>Job</th><th>Cluster</th><th>Namespace</th><th>Phase</th><th>GPUs</th><th>Node</th><th>Result</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in shown"
            :key="`${ r.cluster }/${ r.key }`"
          >
            <td>
              <router-link :to="runRoute(r)">
                {{ r.title }}
              </router-link>
              <div class="text-muted aj-sub">
                {{ r.name }}<template v-if="r.profile">
                  · {{ r.profile }}
                </template>
              </div>
            </td>
            <td>
              <router-link :to="clusterRoute(r.cluster, CLUSTER_PAGES.OVERVIEW)">
                {{ r.clusterName }}
              </router-link>
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
    </template>
  </main>
</template>

<style lang="scss" scoped>
.all-jobs { padding: 20px; }
.aj-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.aj-header p { margin: 4px 0 0; }
.aj-counts { display: flex; flex-wrap: wrap; gap: 20px; margin: 8px 0 16px; }
.aj-toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.aj-toolbar input[type=search] { max-width: 280px; }
.aj-toolbar select { max-width: 220px; }
.aj-check { display: flex; gap: 6px; align-items: center; margin: 0; }
.aj-table { width: 100%; border-collapse: collapse; }
.aj-table th, .aj-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.aj-sub { font-size: 12px; }
</style>
