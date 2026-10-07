<script lang="ts">
// A cluster's Jobs: its AIJob records, a page at a time (runs.ts builds the rows). The page is
// fetched, sorted and filtered by the server (jobspage.ts), and then only the pods, Jobs and volumes
// of the rows shown, by their job-id label, so the page stays the same size however many runs the
// cluster has kept. A row expands to its pods, logs and YAML (RunDetail).
import { defineComponent } from 'vue';
import jsyaml from 'js-yaml';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import { saferDump } from '@shell/utils/create-yaml';
import RunDetail from '../components/RunDetail.vue';
import YamlViewer, { YamlDoc } from '../components/YamlViewer.vue';
import { SUBMIT_PAGE } from '../config';
import { inClusterSection, trainingLink } from '../section';
import { profilesFrom } from '../profiles';
import {
  ago, ALL_RUNS, pageOf, Run, RunFilter, RunSortKey, RunState, trainingToRuns, linkedRun
} from '../runs';
import { CheckpointVolume, checkpointVolumes } from '../checkpoints';
import { trainingRuns } from '../trainingruns';
import {
  fetchJobsPage, fetchProfileConfigMaps, fetchRelated, JOB_STATES, NO_RELATED, RelatedObjects, SORT_FIELDS
} from '../jobspage';

const COLUMNS: { key: RunSortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'profile', label: 'Profile' },
  { key: 'project', label: 'Namespace' },
  { key: 'resources', label: 'Resources' },
  { key: 'state', label: 'State' },
  { key: 'created', label: 'Created' },
];

export default defineComponent({
  name:       'TrainingJobWorkloads',
  // Set when the page is embedded as one tab of the AI Factory Workloads page: the tab is fixed
  // and the page's own title and tab strip are left out.
  // compact: the most recent runs only, as a panel of another page (a cluster's Overview): the table
  // with its expandable rows, without the title, toolbar, pager or kept volumes
  props:      { fixedTab: { type: String, default: null }, compact: { type: Number, default: 0 } },
  components: {
    Loading, Banner, RunDetail, YamlViewer
  },

  data() {
    return {
      // one page of AIJob records, and the objects of those runs only
      aiJobs:       [] as any[],
      related:      NO_RELATED as RelatedObjects,
      total:        0,
      serverPaged:  true,
      configMaps:   [] as any[], // the compute profiles' ConfigMaps
      loadSeq:      0, // a response older than the latest request is dropped
      textTimer:    null as any,
      error:  '' as string,
      // ?project=<namespace>&state=<state>&q=<text> preset the filters, so other pages can link to a view
      filter: {
        ...ALL_RUNS, project: String(this.$route.query.project || ''), state: String(this.$route.query.state || ''), text: String(this.$route.query.q || '')
      } as RunFilter,
      sortKey:  'created' as RunSortKey,
      sortDesc: true,
      page:     1,
      pageSize: 10,
      menuFor:  '' as string, // row key whose ⋯ menu is open
      open:     {} as Record<string, boolean>, // expanded rows, by key
      // a link that names a run (?q=<name>) opens its detail once, when the runs have loaded
      linkOpened: false,
      yaml:     {
        open: false, title: '', docs: [] as YamlDoc[], loading: false, error: ''
      },
      newOpen:    false,
      notice:     '' as string,
      now:        Date.now(),
      timer:      null as any,
      refreshing: false,
    };
  },

  async fetch() {
    this.configMaps = await fetchProfileConfigMaps(this.$store);
    await this.load();
  },

  mounted() {
    // Runs change state on their own: re-read the page shown (a page, not the cluster).
    this.timer = setInterval(() => {
      this.now = Date.now();
      this.load();
    }, 20000);
    document.addEventListener('click', this.closeMenus);
  },

  beforeUnmount() {
    clearInterval(this.timer);
    clearTimeout(this.textTimer);
    document.removeEventListener('click', this.closeMenus);
  },

  computed: {
    columns(): { key: RunSortKey; label: string }[] {
      return COLUMNS;
    },
    clusterSection(): boolean {
      return inClusterSection(this.$route);
    },
    states:  () => JOB_STATES,

    // The tab is in the URL (?tab=training|inference), so a link opens the same view.
    tab(): '' | 'training' | 'inference' {
      if (this.fixedTab) {
        return this.fixedTab as 'training' | 'inference';
      }
      if (this.clusterSection) {
        return 'training'; // a cluster's AI Jobs section lists its training runs
      }
      const t = this.$route.query.tab;

      return t === 'training' || t === 'inference' ? t : '';
    },

    all(): Run[] {
      const rel = this.related;
      const profiles = profilesFrom(this.configMaps, (x: string) => jsyaml.load(x));
      const order = new Map(this.aiJobs.map((j: any, i: number) => [`${ j.metadata?.namespace }/${ j.metadata?.name }`, i]));
      const rows = trainingToRuns(trainingRuns({
        jobs: rel.jobs, pytorchJobs: rel.pytorchJobs, kueueWorkloads: rel.kueueWorkloads, apps: [], pods: rel.pods, aiJobs: this.aiJobs
      }), profiles, rel.claimTemplates);

      // the server's order, and only the page's records (a Job of another run cannot appear)
      return rows
        .filter((r: Run) => order.has(`${ r.namespace }/${ r.name }`))
        .sort((x: Run, y: Run) => (order.get(`${ x.namespace }/${ x.name }`) as number) - (order.get(`${ y.namespace }/${ y.name }`) as number));
    },

    /** Every run's kept checkpoint volume (<run>-checkpoints, made by the chart), with who still uses it. */
    checkpoints(): CheckpointVolume[] {
      return checkpointVolumes(this.related.pvcs, this.related.pods, this.related.jobs);
    },
    /** The namespaces a run can be in: every namespace this user can see on the cluster. */
    projects(): string[] {
      return (this.$store.getters['cluster/all']('namespace') || []).map((n: any) => n.metadata?.name || n.id).filter(Boolean).sort();
    },

    profileOptions(): { value: string; label: string }[] {
      return profilesFrom(this.configMaps, (x: string) => jsyaml.load(x))
        .filter((p: any) => p.type !== 'inference')
        .map((p: any) => ({ value: p.name, label: p.displayName || p.name }))
        .sort((a: any, b: any) => a.label.localeCompare(b.label));
    },

    shown(): Run[] {
      return this.all;
    },
    filtered(): boolean {
      const f = this.filter;

      return !!(f.text || f.project || f.profile || f.state);
    },

    paged(): { items: Run[]; page: number; pages: number; from: number; to: number } {
      if (this.compact) {
        return pageOf(this.all, 1, this.compact);
      }
      const pages = Math.max(1, Math.ceil(this.total / this.pageSize));
      const from = this.total ? (this.page - 1) * this.pageSize + 1 : 0;

      return {
        items: this.all, page: this.page, pages, from, to: Math.min(this.total, from + this.all.length - 1)
      };
    },
    /** The page buttons: the first, the last, and two either side of the current one. */
    pageButtons(): (number | '…')[] {
      const n = this.paged.pages; const c = this.paged.page; const out: (number | '…')[] = [];

      for (let i = 1; i <= n; i++) {
        if (i === 1 || i === n || Math.abs(i - c) <= 2) {
          out.push(i);
        } else if (out[out.length - 1] !== '…') {
          out.push('…');
        }
      }

      return out;
    },
    query(): any {
      return {
        page:      this.compact ? 1 : this.page,
        pageSize:  this.compact || this.pageSize,
        sortKey:   this.compact ? 'created' : this.sortKey,
        sortDesc:  this.compact ? true : this.sortDesc,
        text:      this.filter.text,
        namespace: this.filter.project,
        profile:   this.filter.profile,
        state:     this.filter.state,
      };
    },

    routes(): Record<string, any> {
      return {
        submit:    trainingLink(this.$route, SUBMIT_PAGE),
        training:  trainingLink(this.$route, 'catalog', { tab: 'training' }),
        inference: trainingLink(this.$route, 'catalog', { tab: 'inference' }),
      };
    },
  },

  watch: {
    all(runs: Run[]) {
      const r = this.linkOpened ? null : linkedRun(runs, String(this.$route.query.q || ''));

      if (r) {
        this.open = { ...this.open, [r.key]: true };
        this.linkOpened = true;
      }
    },
    // a filter change starts again at the first page; typing waits for a pause
    'filter.text'() {
      clearTimeout(this.textTimer);
      this.textTimer = setTimeout(() => this.restart(), 300);
    },
    'filter.project'() {
      this.restart();
    },
    'filter.profile'() {
      this.restart();
    },
    'filter.state'() {
      this.restart();
    },
    page() {
      this.load();
    },
    pageSize() {
      this.restart();
    },
    tab() {
      this.page = 1;
    },
  },

  methods: {
    /** The page of runs shown, then their pods, Jobs and volumes. A late answer to an earlier request is dropped. */
    async load() {
      const seq = ++this.loadSeq;

      this.refreshing = true;
      try {
        const page = await fetchJobsPage(this.$store, this.query);

        if (seq !== this.loadSeq) {
          return;
        }
        const related = await fetchRelated(this.$store, page.aiJobs);

        if (seq !== this.loadSeq) {
          return;
        }
        this.aiJobs = page.aiJobs;
        this.total = page.count;
        this.serverPaged = page.serverPaged;
        this.related = related;
        this.error = '';
        // a page past the end (runs deleted, a narrower filter): the last page instead
        if (!this.compact && this.page > 1 && !page.aiJobs.length && page.count) {
          this.page = Math.ceil(page.count / this.pageSize);
        }
      } catch (e: any) {
        if (seq === this.loadSeq) {
          this.error = `Could not list runs: ${ e?.message || e?.data?.message || e }`;
        }
      } finally {
        if (seq === this.loadSeq) {
          this.refreshing = false;
        }
      }
    },

    sortable(key: RunSortKey): boolean {
      return !this.compact && !!SORT_FIELDS[key];
    },

    sortBy(key: RunSortKey) {
      if (!this.sortable(key)) {
        return;
      }
      if (this.sortKey === key) {
        this.sortDesc = !this.sortDesc;
      } else {
        this.sortKey = key;
        this.sortDesc = key === 'created';
      }
      this.restart();
    },

    /** Back to the first page and load it (the page watcher loads when the page changes). */
    restart() {
      if (this.page === 1) {
        this.load();
      } else {
        this.page = 1;
      }
    },

    ago(iso: string): string {
      return ago(iso, this.now);
    },

    stateClass(s: RunState): string {
      return ({
        Running: 'ok', Completed: 'done', Failed: 'bad', Degraded: 'warn', Queued: 'info', Pending: 'info', Deploying: 'info', Suspended: 'muted'
      } as Record<string, string>)[s] || 'muted';
    },

    toggleOpen(r: Run) {
      this.open = { ...this.open, [r.key]: !this.open[r.key] };
    },

    /**
     * The objects as the API server stores them (defaults, scheduler name and requests included), so
     * a training Job can be copied into Submit → YAML and re-applied. cleanForDownload strips
     * managedFields and the other bookkeeping that makes a manifest un-reappliable.
     */
    async fetchYaml(resource: any): Promise<string> {
      if (!resource?.hasLink?.('view')) {
        throw new Error('This resource does not expose a view link, so its YAML cannot be read.');
      }
      const res = await resource.followLink('view', { headers: { accept: 'application/yaml' } });

      return resource.cleanForDownload ? await resource.cleanForDownload(res.data) : res.data;
    },

    async showYaml(r: Run) {
      this.yaml = {
        open: true, title: `${ r.namespace }/${ r.name }`, docs: [], loading: true, error: ''
      };
      const docs: YamlDoc[] = [];

      try {
        const job = r.training?.job;
        const app = r.training?.app;

        if (job) {
          docs.push({
            label: job.kind || 'Job', yaml: await this.fetchYaml(job), filename: r.name, hint: 'The live object. Copy it into Submit → YAML → Kubernetes manifest to run a variant of this job.'
          });
        }
        const values = app?.spec?.values || r.training?.aiJob?.spec?.values;

        if (values) {
          docs.push({
            label: 'Helm values', yaml: saferDump(values), filename: `${ r.name }-values`, hint: 'The values this run was installed with. Copy them into Submit → YAML → Helm values to rerun with tweaks.'
          });
        }
        if (r.inference?.workload) {
          docs.push({
            label: 'AIWorkload', yaml: await this.fetchYaml(r.inference.workload), filename: r.name, hint: 'The SUSE AI Factory workload. The operator renders its blueprint into Fleet HelmOps.'
          });
        }
        if (!docs.length) {
          this.yaml.error = 'Nothing to show: the Job has been cleaned up and the Helm release records no values.';
        }
        this.yaml.docs = docs;
      } catch (e: any) {
        this.yaml.error = e?.message || String(e);
      } finally {
        this.yaml.loading = false;
      }
    },

    toggleMenu(r: Run) {
      this.menuFor = this.menuFor === r.key ? '' : r.key;
    },

    closeMenus() {
      this.menuFor = '';
      this.newOpen = false;
    },

    async copy(text: string) {
      try {
        await navigator.clipboard.writeText(text);
        this.notice = `Copied ${ text }`;
      } catch (e) {
        this.notice = text;
      }
      this.menuFor = '';
    },

    // Rancher's own confirmation dialog: Helm uninstall for a training release, delete for an
    // AIWorkload (the AI Factory operator then removes what its blueprint installed).
    checkpointOf(r: Run): CheckpointVolume | null {
      return r.type === 'training' ? this.checkpoints.find((k) => k.run === r.name && k.namespace === r.namespace) || null : null;
    },
    /** Rancher's own confirmation dialog, as for a run; the volume's data goes with it. */
    removeCheckpoint(k: CheckpointVolume) {
      if (!k.obj?.promptRemove) {
        return;
      }
      k.obj.promptRemove();
      const off = this.$store.watch((st: any) => st['action-menu']?.showPromptRemove, (shown: boolean) => {
        if (!shown) {
          off();
          setTimeout(() => this.load(), 1500);
        }
      });
    },
    remove(r: Run) {
      this.menuFor = '';
      if (!r.obj?.promptRemove) {
        return;
      }
      r.obj.promptRemove();
      const off = this.$store.watch((st: any) => st['action-menu']?.showPromptRemove, (shown: boolean) => {
        if (!shown) {
          off();
          setTimeout(() => this.load(), 1500);
        }
      });
    },
  },
});
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    :class="['tj-workloads', { embedded: fixedTab }]"
  >
    <!-- Laid out like Profiles, Apps and Blueprints: title, then one toolbar row of search, filters
         and actions. Embedded as the Workloads page's Training tab, the toolbar moves into that
         page's header, above its tabs. -->
    <header
      v-if="!fixedTab && !compact"
      class="fixed-header"
    >
      <h1>{{ clusterSection ? 'Jobs' : t('trainingjobs.endpoints.title') }}</h1>
    </header>
    <Teleport
      v-if="!compact"
      defer
      to="#workloads-toolbar"
      :disabled="!fixedTab"
    >
      <div
        class="actions-container tj-toolbar"
        role="toolbar"
      >
        <div class="search-box">
          <input
            v-model="filter.text"
            type="search"
            class="input-sm"
            placeholder="Search runs"
            aria-label="Search runs"
          >
        </div>
        <select
          v-model="filter.project"
          class="sort-select form-control-sm"
          aria-label="Project"
        >
          <option value="">
            All projects
          </option>
          <option
            v-for="p in projects"
            :key="p"
            :value="p"
          >
            {{ p }}
          </option>
        </select>
        <select
          v-model="filter.profile"
          class="sort-select form-control-sm"
          aria-label="Profile"
        >
          <option value="">
            All profiles
          </option>
          <option
            v-for="p in profileOptions"
            :key="p.value"
            :value="p.value"
          >
            {{ p.label }}
          </option>
        </select>
        <select
          v-model="filter.state"
          class="sort-select form-control-sm"
          aria-label="State"
        >
          <option value="">
            All states
          </option>
          <option
            v-for="s in states"
            :key="s"
            :value="s"
          >
            {{ s }}
          </option>
        </select>
        <div
          class="tj-new ml-auto"
          @click.stop
        >
          <button
            class="btn role-primary"
            type="button"
            @click="newOpen = !newOpen"
          >
            <i class="icon icon-plus" /> New run <i class="icon icon-chevron-down" />
          </button>
          <ul
            v-if="newOpen"
            class="tj-menu tj-menu-right"
          >
            <li>
              <router-link :to="routes.training">
                Training run from a profile
              </router-link>
            </li>
            <li>
              <router-link :to="routes.inference">
                Inference endpoint from a profile
              </router-link>
            </li>
            <li>
              <router-link :to="routes.submit">
                Custom training job (full form)
              </router-link>
            </li>
          </ul>
        </div>
        <button
          v-clean-tooltip="'Refresh'"
          class="btn role-tertiary tj-icon-button"
          type="button"
          aria-label="Refresh"
          :disabled="refreshing"
          @click="load()"
        >
          <i :class="['icon', refreshing ? 'icon-spinner icon-spin' : 'icon-refresh']" />
        </button>
      </div>
    </Teleport>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="notice"
      color="info"
      :label="notice"
      :closable="true"
      @close="notice = ''"
    />




    <p
      v-if="!all.length && !refreshing && !filtered"
      class="text-muted"
    >
      Nothing has run yet. Start a training run or an inference endpoint with New run.
    </p>
    <p
      v-else-if="!all.length && !refreshing"
      class="text-muted"
    >
      No runs match the filters.
    </p>

    <table
      v-else
      class="tj-table"
    >
      <thead>
        <tr>
          <th
            v-for="c in columns"
            :key="c.key"
            :class="{ 'tj-sortable': sortable(c.key), sorted: !compact && sortKey === c.key }"
            @click="sortBy(c.key)"
          >
            {{ c.label }}
            <i
              v-if="!compact && sortKey === c.key"
              :class="['icon', sortDesc ? 'icon-chevron-down' : 'icon-chevron-up']"
            />
          </th>
          <th class="tj-actions-col" />
        </tr>
      </thead>
      <tbody>
        <template
          v-for="r in paged.items"
          :key="r.key"
        >
          <tr :class="{ 'tj-open': open[r.key] }">
            <td>
              <a
                href="#"
                class="tj-name"
                :aria-expanded="!!open[r.key]"
                @click.prevent="toggleOpen(r)"
              ><i :class="['icon', open[r.key] ? 'icon-chevron-down' : 'icon-chevron-right', 'tj-chev']" />{{ r.name }}</a>
            </td>
            <td>{{ r.profileLabel }}</td>
            <td>{{ r.namespace }}</td>
            <td>{{ r.resources }}</td>
            <td>
              <span :class="['tj-state', stateClass(r.state)]"><i class="tj-dot" />{{ r.state }}</span>
            </td>
            <td :title="r.created">
              {{ ago(r.created) }}
            </td>
            <td
              class="tj-actions-col"
              @click.stop
            >
              <button
                class="btn role-link btn-sm"
                aria-label="Actions"
                @click="toggleMenu(r)"
              >
                <i class="icon icon-actions" />
              </button>
              <ul
                v-if="menuFor === r.key"
                class="tj-menu tj-menu-right"
              >
                <li>
                  <a
                    href="#"
                    @click.prevent="toggleOpen(r); menuFor = ''"
                  >{{ open[r.key] ? 'Hide details' : 'Show details' }}</a>
                </li>
                <li v-if="r.url">
                  <a
                    href="#"
                    @click.prevent="copy(r.url)"
                  >Copy endpoint URL</a>
                </li>
                <li>
                  <a
                    href="#"
                    class="text-error"
                    @click.prevent="remove(r)"
                  >Delete</a>
                </li>
              </ul>
            </td>
          </tr>
          <tr
            v-if="open[r.key]"
            class="tj-detail-row"
          >
            <td :colspan="columns.length + 1">
              <RunDetail
                :run="r"
                :checkpoint="checkpointOf(r)"
                @yaml="showYaml"
                @remove="remove"
                @copy="copy"
                @remove-checkpoint="removeCheckpoint"
              />
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div
      v-if="total && !compact"
      class="tj-pager"
    >
      <span class="text-muted">{{ paged.from }}–{{ paged.to }} of {{ total }} run{{ total === 1 ? '' : 's' }}</span>
      <div class="tj-pages">
        <button
          class="btn role-secondary btn-sm"
          :disabled="paged.page <= 1"
          aria-label="Previous page"
          @click="page = paged.page - 1"
        >
          <i class="icon icon-chevron-left" />
        </button>
        <template
          v-for="(n, i) in pageButtons"
          :key="i"
        >
          <span
            v-if="n === '…'"
            class="text-muted"
          >…</span>
          <button
            v-else
            :class="['btn', 'btn-sm', n === paged.page ? 'role-primary' : 'role-secondary']"
            @click="page = n"
          >
            {{ n }}
          </button>
        </template>
        <button
          class="btn role-secondary btn-sm"
          :disabled="paged.page >= paged.pages"
          aria-label="Next page"
          @click="page = paged.page + 1"
        >
          <i class="icon icon-chevron-right" />
        </button>
        <select
          v-model.number="pageSize"
          aria-label="Rows per page"
          @change="page = 1"
        >
          <option :value="10">
            10 / page
          </option>
          <option :value="25">
            25 / page
          </option>
          <option :value="50">
            50 / page
          </option>
        </select>
      </div>
    </div>



    <YamlViewer
      v-if="yaml.open"
      :title="yaml.title"
      :docs="yaml.docs"
      :loading="yaml.loading"
      :error="yaml.error"
      @close="yaml.open = false"
    />
  </div>
</template>

<style lang="scss" scoped>

.tj-workloads { padding: 12px 20px 20px; &.embedded { padding: 0; } }
.tj-new { position: relative; }
.tj-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
.tj-tab { padding: 8px 16px; border-bottom: 2px solid transparent; color: var(--body-text); text-decoration: none;
  &.active { border-bottom-color: var(--primary); color: var(--primary); font-weight: 600; } }
.tj-table { width: 100%; border-collapse: collapse;
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { font-weight: 600; font-size: 13px; white-space: nowrap; } }
.tj-sortable { cursor: pointer; user-select: none; &.sorted { color: var(--primary); } .icon { font-size: 10px; } }
.tj-name { font-weight: 600; }
.tj-chev { font-size: 10px; margin-right: 6px; color: var(--muted); }
.tj-open td { border-bottom: none; }
.tj-detail-row > td { padding: 0 0 10px; }
.tj-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 10px; border-radius: 10px; background: var(--border);
  &.ok { background: var(--success-banner-bg); color: var(--success); }
  &.done { background: var(--success-banner-bg); color: var(--success); opacity: 0.8; }
  &.bad { background: var(--error-banner-bg); color: var(--error); }
  &.warn { background: var(--warning-banner-bg); color: var(--warning); }
  &.info { background: var(--info-banner-bg); color: var(--info); }
  &.muted { color: var(--muted); } }
.tj-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; display: inline-block; }
.tj-actions-col { width: 48px; text-align: right; position: relative; }
.tj-menu { position: absolute; z-index: 20; list-style: none; margin: 4px 0 0; padding: 4px 0; min-width: 220px; background: var(--dropdown-bg, var(--body-bg)); border: 1px solid var(--border); border-radius: var(--border-radius); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12); text-align: left;
  li a { display: block; padding: 6px 14px; white-space: nowrap; }
  li a:hover { background: var(--dropdown-hover-bg, var(--border)); text-decoration: none; } }
.tj-menu-right { right: 0; }
.tj-pager { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; flex-wrap: wrap; gap: 10px; }
.tj-pages { display: flex; gap: 6px; align-items: center; select { width: auto; height: 32px; padding: 0 8px; } }
.tj-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  // an icon beside its label, with room between them
  .btn { gap: 6px; }
  .tj-icon-button { padding: 0 10px; min-width: 0; }
  flex-wrap: wrap;
  margin-bottom: 20px;
  .search-box .input-sm {
    width: 200px;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: var(--border-radius);
    background: var(--input-bg);
    color: var(--body-text);
    font-size: 14px;
  }
  .sort-select {
    height: 30px;
    padding: 0 6px 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--border-radius);
    background: var(--input-bg);
    color: var(--body-text);
    font-size: 13px;
    width: auto;
  }
  .ml-auto { margin-left: auto; }
}
</style>
