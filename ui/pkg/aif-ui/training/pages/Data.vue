<script lang="ts">
// A cluster's Data: the volumes AI runs created on it, a page at a time (datapage.ts), with what
// mounts each and how much room storage has left. A volume no pod names can be deleted, one at a
// time or several together, through Rancher's own confirmation. One a finished pod still names is
// held by Kubernetes until that pod goes: its run's execution is cleaned up, now if asked.
import { defineComponent } from 'vue';
import Banner from '@components/Banner/Banner.vue';
import Loading from '@shell/components/Loading.vue';
import VolumeFiles from '../components/VolumeFiles.vue';
import { ago } from '../runs';
import { trainingLink } from '../section';
import {
  asCheckpoint, cleanUpRun, fetchStorageSummary, fetchVolumesPage, freeToDelete, StorageSummary, VolumeRow, VolumeScope, VolumeSortKey
} from '../datapage';

const COLUMNS: { key: string; label: string; sort?: VolumeSortKey }[] = [
  { key: 'name', label: 'Volume', sort: 'name' },
  { key: 'namespace', label: 'Namespace', sort: 'namespace' },
  { key: 'run', label: 'Run' },
  { key: 'kind', label: 'Kind' },
  { key: 'size', label: 'Size' },
  { key: 'class', label: 'Storage class' },
  { key: 'use', label: 'Status' },
  { key: 'created', label: 'Created', sort: 'created' },
];

const KIND_LABEL: Record<string, string> = { checkpoint: 'Checkpoints', scratch: 'Scratch', other: 'Other' };

export default defineComponent({
  name:       'TrainingData',
  components: { Banner, Loading, VolumeFiles },

  data() {
    return {
      rows:      [] as VolumeRow[],
      total:     0,
      storage:   null as StorageSummary | null,
      scope:     'runs' as VolumeScope,
      text:      '',
      namespace: '',
      sortKey:   'created' as VolumeSortKey,
      sortDesc:  true,
      page:      1,
      pageSize:  25,
      selected:  {} as Record<string, boolean>,
      browsing:  '' as string,
      confirmCleanUp: '' as string, // the row whose Clean up run waits for a second click
      notice:    '',
      error:     '',
      loading:   false,
      loadSeq:   0,
      now:       Date.now(),
      timer:     null as any,
      textTimer: null as any,
    };
  },

  async fetch() {
    await Promise.all([this.load(), this.loadStorage()]);
  },

  mounted() {
    // volumes change when runs start and finish: re-read the page shown, not every volume
    this.timer = setInterval(() => {
      this.now = Date.now();
      this.load();
    }, 30000);
  },

  beforeUnmount() {
    clearInterval(this.timer);
    clearTimeout(this.textTimer);
  },

  computed: {
    columns: () => COLUMNS,
    namespaces(): string[] {
      return (this.$store.getters['cluster/all']('namespace') || []).map((n: any) => n.metadata?.name || n.id).filter(Boolean).sort();
    },
    pages(): number {
      return Math.max(1, Math.ceil(this.total / this.pageSize));
    },
    from(): number {
      return this.total ? (this.page - 1) * this.pageSize + 1 : 0;
    },
    to(): number {
      return Math.min(this.total, this.from + this.rows.length - 1);
    },
    /** Selected volumes that can go: no pod, running or finished, still names them. */
    deletable(): VolumeRow[] {
      return this.rows.filter((r: VolumeRow) => this.selected[r.key] && freeToDelete(r));
    },
    allSelected(): boolean {
      const free = this.rows.filter(freeToDelete);

      return !!free.length && free.every((r: VolumeRow) => this.selected[r.key]);
    },
    /** A new run's volumes need room on three nodes (three replicas). */
    storageTight(): boolean {
      return !!this.storage && this.storage.nodesWithRoom < 3;
    },
  },

  watch: {
    text() {
      clearTimeout(this.textTimer);
      this.textTimer = setTimeout(() => this.restart(), 300);
    },
    scope() {
      this.restart();
    },
    namespace() {
      this.restart();
    },
    pageSize() {
      this.restart();
    },
    page() {
      this.load();
    },
  },

  methods: {
    restart() {
      this.selected = {};
      if (this.page === 1) {
        this.load();
      } else {
        this.page = 1;
      }
    },

    async load() {
      const seq = ++this.loadSeq;

      this.loading = true;
      try {
        const res = await fetchVolumesPage(this.$store, {
          page: this.page, pageSize: this.pageSize, sortKey: this.sortKey, sortDesc: this.sortDesc, text: this.text, namespace: this.namespace, scope: this.scope
        });

        if (seq !== this.loadSeq) {
          return;
        }
        this.rows = res.rows;
        this.total = res.count;
        this.error = '';
        if (this.page > 1 && !res.rows.length && res.count) {
          this.page = Math.ceil(res.count / this.pageSize);
        }
      } catch (e: any) {
        if (seq === this.loadSeq) {
          this.error = `Could not list volumes: ${ e?.message || e?.data?.message || e }`;
        }
      } finally {
        if (seq === this.loadSeq) {
          this.loading = false;
        }
      }
    },

    async loadStorage() {
      this.storage = await fetchStorageSummary(this.$store);
    },

    refresh() {
      this.load();
      this.loadStorage();
    },

    sortBy(c: { sort?: VolumeSortKey }) {
      if (!c.sort) {
        return;
      }
      if (this.sortKey === c.sort) {
        this.sortDesc = !this.sortDesc;
      } else {
        this.sortKey = c.sort;
        this.sortDesc = c.sort === 'created';
      }
      this.restart();
    },

    toggleAll() {
      const on = !this.allSelected;

      this.selected = Object.fromEntries(this.rows.filter(freeToDelete).map((r: VolumeRow) => [r.key, on]));
    },

    freeToDelete,

    /** Clean up the run whose finished pods hold this volume; asks for a second click first. */
    async cleanUp(r: VolumeRow) {
      if (this.confirmCleanUp !== r.key) {
        this.confirmCleanUp = r.key;

        return;
      }
      this.confirmCleanUp = '';
      try {
        await cleanUpRun(this.$store, String(this.$route.params.cluster), r.namespace, r.run);
        this.notice = `Cleaning up ${ r.run }: its pods go within a minute, and the volumes they held can then be deleted. Its record and results stay.`;
        setTimeout(() => this.load(), 5000);
      } catch (e: any) {
        this.error = `Could not clean up ${ r.run }: ${ e?.message || e?.data?.message || e }`;
      }
    },

    kindLabel(k: string): string {
      return KIND_LABEL[k] || k;
    },

    ago(iso: string): string {
      return ago(iso, this.now);
    },

    runLink(r: VolumeRow): any {
      return trainingLink(this.$route, 'jobs', { q: r.run });
    },

    asCheckpoint,

    /** Rancher's confirmation dialog, which lists every volume and deletes them on confirm. */
    remove(rows: VolumeRow[]) {
      const models = rows.map((r) => r.obj).filter((o) => o?.promptRemove);

      if (!models.length) {
        return;
      }
      models[0].promptRemove(models);
      const off = this.$store.watch((st: any) => st['action-menu']?.showPromptRemove, (shown: boolean) => {
        if (!shown) {
          off();
          this.selected = {};
          setTimeout(() => this.refresh(), 1500);
        }
      });
    },
  },
});
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <main
    v-else
    class="td-data"
  >
    <header class="td-header">
      <h1>Data</h1>
      <p class="text-muted">
        Volumes your runs created on this cluster: checkpoints, kept after a run until deleted, and scratch space, removed with its run's pods.
      </p>
    </header>

    <section
      v-if="storage"
      :class="['td-storage', { tight: storageTight }]"
    >
      <div>
        <strong>Longhorn: {{ storage.reservedGiB }} of {{ storage.capacityGiB }} GiB reserved</strong>
        <span class="text-muted"> · room for a new 10 GiB volume on {{ storage.nodesWithRoom }} of {{ storage.nodes.length }} nodes</span>
      </div>
      <div
        v-if="storageTight"
        class="td-warn"
      >
        New runs may wait for storage: a volume's three replicas need room on three nodes. Delete volumes that are no longer needed, below.
      </div>
    </section>

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

    <div
      class="td-toolbar"
      role="toolbar"
    >
      <input
        v-model="text"
        type="search"
        class="input-sm"
        placeholder="Search volumes"
        aria-label="Search volumes"
      >
      <select
        v-model="scope"
        class="form-control-sm"
        aria-label="Kind"
      >
        <option value="runs">
          Run volumes
        </option>
        <option value="checkpoint">
          Checkpoints
        </option>
        <option value="scratch">
          Scratch
        </option>
        <option value="all">
          All volumes
        </option>
      </select>
      <select
        v-model="namespace"
        class="form-control-sm"
        aria-label="Namespace"
      >
        <option value="">
          All namespaces
        </option>
        <option
          v-for="n in namespaces"
          :key="n"
          :value="n"
        >
          {{ n }}
        </option>
      </select>
      <button
        class="btn role-secondary ml-auto"
        :disabled="!deletable.length"
        @click="remove(deletable)"
      >
        <i class="icon icon-trash" /> Delete selected{{ deletable.length ? ` (${ deletable.length })` : '' }}
      </button>
      <button
        v-clean-tooltip="'Refresh'"
        class="btn role-tertiary td-icon-button"
        aria-label="Refresh"
        :disabled="loading"
        @click="refresh()"
      >
        <i :class="['icon', loading ? 'icon-spinner icon-spin' : 'icon-refresh']" />
      </button>
    </div>

    <p
      v-if="!rows.length && !loading"
      class="text-muted"
    >
      {{ text || namespace || scope !== 'runs' ? 'No volumes match the filters.' : 'No run has created a volume on this cluster.' }}
    </p>

    <table
      v-else
      class="td-table"
    >
      <thead>
        <tr>
          <th class="td-check">
            <input
              type="checkbox"
              :checked="allSelected"
              aria-label="Select all volumes not in use"
              @change="toggleAll"
            >
          </th>
          <th
            v-for="c in columns"
            :key="c.key"
            :class="{ 'td-sortable': !!c.sort, sorted: c.sort && sortKey === c.sort }"
            @click="sortBy(c)"
          >
            {{ c.label }}
            <i
              v-if="c.sort && sortKey === c.sort"
              :class="['icon', sortDesc ? 'icon-chevron-down' : 'icon-chevron-up']"
            />
          </th>
          <th />
        </tr>
      </thead>
      <tbody>
        <template
          v-for="r in rows"
          :key="r.key"
        >
          <tr>
            <td class="td-check">
              <input
                v-model="selected[r.key]"
                type="checkbox"
                :disabled="!freeToDelete(r)"
                :aria-label="`Select ${ r.name }`"
              >
            </td>
            <td class="td-name">
              {{ r.name }}
            </td>
            <td>{{ r.namespace }}</td>
            <td>
              <router-link
                v-if="r.run"
                :to="runLink(r)"
              >
                {{ r.run }}
              </router-link>
              <span
                v-else
                class="text-muted"
              >—</span>
            </td>
            <td>{{ kindLabel(r.kind) }}</td>
            <td>{{ r.size }}</td>
            <td>{{ r.storageClass || '—' }}</td>
            <td>
              <span
                v-if="r.deleting"
                v-clean-tooltip="r.heldBy.length || r.inUseBy.length ? `Waiting for ${ [...r.inUseBy, ...r.heldBy].join(', ') } to go` : 'Being deleted'"
                class="td-deleting"
              ><i class="icon icon-spinner icon-spin" /> Deleting</span>
              <span
                v-else-if="r.inUseBy.length"
                v-clean-tooltip="r.inUseBy.join(', ')"
              >In use by {{ r.inUseBy.length }} pod{{ r.inUseBy.length === 1 ? '' : 's' }}</span>
              <span
                v-else-if="r.heldBy.length"
                v-clean-tooltip="`${ r.heldBy.join(', ') } finished but is kept until the run is cleaned up (its retention); the volume cannot be deleted before then`"
              >Held by finished pod</span>
              <span
                v-else
                class="text-muted"
              >Not in use</span>
            </td>
            <td :title="r.created">
              {{ ago(r.created) }}
            </td>
            <td class="td-right">
              <button
                v-if="!r.inUseBy.length"
                class="btn role-tertiary btn-sm"
                :aria-expanded="browsing === r.key"
                @click="browsing = browsing === r.key ? '' : r.key"
              >
                <i class="icon icon-folder" /> {{ browsing === r.key ? 'Hide files' : 'Browse files' }}
              </button>
              <button
                v-if="!r.inUseBy.length && r.heldBy.length && r.run"
                class="btn role-tertiary btn-sm"
                @click="cleanUp(r)"
              >
                {{ confirmCleanUp === r.key ? 'Remove its pods and logs now?' : 'Clean up run' }}
              </button>
              <button
                v-if="freeToDelete(r)"
                class="btn role-tertiary btn-sm text-error"
                :aria-label="`Delete ${ r.name }`"
                @click="remove([r])"
              >
                <i class="icon icon-trash" />
              </button>
            </td>
          </tr>
          <tr v-if="browsing === r.key">
            <td :colspan="columns.length + 2">
              <VolumeFiles :checkpoint="asCheckpoint(r)" />
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div
      v-if="total"
      class="td-pager"
    >
      <span class="text-muted">{{ from }}–{{ to }} of {{ total }} volume{{ total === 1 ? '' : 's' }}</span>
      <div class="td-pages">
        <button
          class="btn role-secondary btn-sm"
          :disabled="page <= 1"
          aria-label="Previous page"
          @click="page = page - 1"
        >
          <i class="icon icon-chevron-left" />
        </button>
        <span class="text-muted">Page {{ page }} of {{ pages }}</span>
        <button
          class="btn role-secondary btn-sm"
          :disabled="page >= pages"
          aria-label="Next page"
          @click="page = page + 1"
        >
          <i class="icon icon-chevron-right" />
        </button>
        <select
          v-model.number="pageSize"
          aria-label="Rows per page"
        >
          <option :value="25">
            25 / page
          </option>
          <option :value="50">
            50 / page
          </option>
          <option :value="100">
            100 / page
          </option>
        </select>
      </div>
    </div>
  </main>
</template>

<style lang="scss" scoped>
.td-data { padding: 12px 20px 20px; }
.td-header { margin-bottom: 16px; h1 { margin-bottom: 4px; } p { margin: 0; } }
.td-storage { border: 1px solid var(--border); border-radius: var(--border-radius); padding: 12px 16px; margin-bottom: 16px;
  &.tight { border-color: var(--warning); } }
.td-warn { margin-top: 6px; color: var(--warning); }
.td-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px;
  .btn { gap: 6px; }
  .td-icon-button { padding: 0 10px; min-width: 0; }
  .ml-auto { margin-left: auto; }
  input[type=search] { width: 200px; height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--border-radius); background: var(--input-bg); color: var(--body-text); }
  select { height: 30px; width: auto; padding: 0 6px 0 8px; border: 1px solid var(--border); border-radius: var(--border-radius); background: var(--input-bg); color: var(--body-text); font-size: 13px; } }
.td-table { width: 100%; border-collapse: collapse;
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { font-weight: 600; font-size: 13px; white-space: nowrap; } }
.td-check { width: 32px; }
.td-name { font-weight: 600; }
.td-deleting { color: var(--muted); }
.td-right { text-align: right; white-space: nowrap; }
.td-sortable { cursor: pointer; user-select: none; &.sorted { color: var(--primary); } .icon { font-size: 10px; } }
.td-pager { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; flex-wrap: wrap; gap: 10px; }
.td-pages { display: flex; gap: 8px; align-items: center; select { width: auto; height: 32px; padding: 0 8px; } }
</style>
