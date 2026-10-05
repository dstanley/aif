<script lang="ts">
// Place a project on clusters: the same project, members and namespaces on each cluster it spans.
// Slides in from the right like the Blueprints detail panel. Apply copies what each cluster is
// missing with the user's own Rancher rights, and records the placement on the project.
import { defineComponent, PropType } from 'vue';
import Banner from '@components/Banner/Banner.vue';
import ClusterResourceTable from '../../pages/components/ClusterResourceTable.vue';
import { getAllClusters } from '../../services/rancher-apps';
import {
  bindingsOf, describePlan, inStep, Plan, placedClusters, planPlacement, ProjectLike, BindingLike
} from '../placement';
import { applyPlan, clusterNamespaces, savePlacement } from '../placement-api';
import { memberLabel } from '../projects';

export default defineComponent({
  name:       'ProjectPlacementPanel',
  components: { Banner, ClusterResourceTable },
  props:      {
    /** the Rancher Project being placed (management.cattle.io.project, as listed) */
    source:     { type: Object as PropType<ProjectLike>, required: true },
    /** its namespaces on its own cluster */
    namespaces: { type: Array as PropType<string[]>, default: () => [] },
    /** every Rancher project and member binding on the management cluster */
    projects:   { type: Array as PropType<ProjectLike[]>, default: () => [] },
    bindings:   { type: Array as PropType<BindingLike[]>, default: () => [] },
    /** user and role ids to names, for showing members */
    userNames:  { type: Object as PropType<Record<string, string>>, default: () => ({}) },
    roleNames:  { type: Object as PropType<Record<string, string>>, default: () => ({}) },
  },
  emits: ['close', 'applied'],

  data() {
    return {
      selected:      placedClusters(this.source),
      nsByCluster:   {} as Record<string, any[] | null>,
      // Rancher cluster ids to the names people know them by
      clusterNames:  {} as Record<string, string>,
      loadErrors:    {} as Record<string, string>,
      applying:      false,
      log:           [] as string[],
      error:         '',
    };
  },

  computed: {
    home(): string {
      return this.source.metadata?.namespace || 'local';
    },
    title(): string {
      return this.source.spec?.displayName || this.source.metadata?.name || '';
    },
    members(): string {
      const m = bindingsOf(`${ this.home }:${ this.source.metadata?.name }`, this.bindings);

      return m.length ? m.map((b) => this.label(b)).join(', ') : 'none';
    },
    others(): string[] {
      return this.selected.filter((c) => c !== this.home);
    },
    plans(): Plan[] {
      return this.others.filter((c) => this.nsByCluster[c]).map((c) => planPlacement(this.source, this.namespaces, c, this.projects, this.bindings, this.nsByCluster[c] || []));
    },
    placementChanged(): boolean {
      const was = placedClusters(this.source).slice().sort().join(',');

      return was !== this.selected.slice().sort().join(',');
    },
    removed(): string[] {
      return placedClusters(this.source).filter((c) => !this.selected.includes(c));
    },
    nothingToDo(): boolean {
      return !this.placementChanged && this.plans.every(inStep);
    },
    loadingTargets(): boolean {
      return this.others.some((c) => this.nsByCluster[c] === undefined && !this.loadErrors[c]);
    },
  },

  async mounted() {
    try {
      this.clusterNames = Object.fromEntries((await getAllClusters(this.$store)).map((c) => [c.id, c.name]));
    } catch {
      // ids, then
    }
  },

  watch: {
    others: {
      immediate: true,
      handler(cs: string[]) {
        cs.forEach((c) => this.loadCluster(c));
      },
    },
  },

  methods: {
    describePlan,
    inStep,
    label(b: { userName?: string; userPrincipalName?: string; groupPrincipalName?: string; role: string }): string {
      return b.groupPrincipalName ? memberLabel({ name: b.groupPrincipalName, kind: 'group', role: b.role }, this.userNames, this.roleNames) : memberLabel({ name: b.userName || b.userPrincipalName || '', kind: 'user', role: b.role }, this.userNames, this.roleNames);
    },
    nameOf(c: string): string {
      return this.clusterNames[c] || c;
    },
    req(opt: any) {
      return this.$store.dispatch('management/request', opt);
    },
    async loadCluster(c: string) {
      if (this.nsByCluster[c] !== undefined) {
        return;
      }
      this.nsByCluster = { ...this.nsByCluster, [c]: undefined as any };
      try {
        const list = await clusterNamespaces(this.req, c);

        this.nsByCluster = { ...this.nsByCluster, [c]: list };
      } catch (e: any) {
        this.loadErrors = { ...this.loadErrors, [c]: `cannot read its namespaces: ${ e?.message || e?._statusText || e }` };
      }
    },
    /** the project's own cluster stays placed */
    onSelect(cs: string[]) {
      this.selected = cs.includes(this.home) ? cs : [this.home, ...cs];
    },
    async apply() {
      this.applying = true;
      this.error = '';
      this.log = [];
      try {
        for (const p of this.plans) {
          if (!inStep(p)) {
            this.log.push(...await applyPlan(this.req, this.source, p, undefined, this.nameOf, this.label));
          }
        }
        if (this.placementChanged) {
          await savePlacement(this.req, this.source, this.selected);
          this.log.push(`Placed on ${ this.selected.map(this.nameOf).join(', ') }`);
        }
      } catch (e: any) {
        this.error = e?.message || e?._statusText || String(e);
      } finally {
        // check again what each cluster has, and let the page reload the projects and members
        this.nsByCluster = {};
        this.loadErrors = {};
        this.others.forEach((c) => this.loadCluster(c));
        this.$emit('applied');
        this.applying = false;
      }
    },
  },
});
</script>

<template>
  <div>
    <div
      class="pp-backdrop"
      @click="$emit('close')"
    />
    <aside
      class="pp-panel"
      :aria-label="`Place ${ title } on clusters`"
    >
      <header class="pp-header">
        <span class="pp-title">Place {{ title }} on clusters</span>
        <button
          class="btn role-link pp-close"
          aria-label="Close panel"
          @click="$emit('close')"
        >
          <i class="icon icon-close" />
        </button>
      </header>
      <div class="pp-body">
        <p class="text-muted">
          The same project, members and namespaces on each cluster selected, so the team and its runs
          are the same wherever they go. Quotas stay per cluster. {{ nameOf(home) }} is where it is defined.
        </p>
        <dl class="pp-facts">
          <div>
            <dt>Namespaces</dt><dd>{{ namespaces.join(', ') || 'none' }}</dd>
          </div>
          <div>
            <dt>Members</dt><dd>{{ members }}</dd>
          </div>
        </dl>

        <h3>Clusters</h3>
        <ClusterResourceTable
          :selected-clusters="selected"
          :multi-select="true"
          :summary="false"
          :disabled="applying"
          @update:selected-clusters="onSelect"
        />

        <h3 v-if="others.length || removed.length">
          On each cluster
        </h3>
        <ul class="pp-plans">
          <li
            v-for="c in others"
            :key="c"
          >
            <template v-if="loadErrors[c]">
              <i class="icon icon-warning text-warning" /> <strong>{{ nameOf(c) }}</strong> {{ loadErrors[c] }}
            </template>
            <template v-else-if="!nsByCluster[c]">
              <i class="icon icon-spinner icon-spin" /> <strong>{{ nameOf(c) }}</strong> checking…
            </template>
            <template v-else>
              <i
                :class="['icon', inStep(plans.find(p => p.cluster === c)) ? 'icon-checkmark text-success' : plans.find(p => p.cluster === c).projectConflict ? 'icon-warning text-warning' : 'icon-plus']"
              />
              <strong>{{ nameOf(c) }}</strong> {{ describePlan(plans.find(p => p.cluster === c)) }}
            </template>
          </li>
          <li
            v-for="c in removed"
            :key="`removed-${ c }`"
          >
            <i class="icon icon-minus" /> <strong>{{ nameOf(c) }}</strong> no longer placed: its copy, namespaces and workloads are kept
          </li>
        </ul>

        <Banner
          v-if="error"
          color="error"
          :label="error"
        />
        <Banner
          v-if="log.length"
          color="success"
        >
          <ul class="pp-log">
            <li
              v-for="(l, i) in log"
              :key="i"
            >
              {{ l }}
            </li>
          </ul>
        </Banner>
      </div>
      <footer class="pp-footer">
        <button
          class="btn role-secondary"
          :disabled="applying"
          @click="$emit('close')"
        >
          {{ log.length ? 'Close' : 'Cancel' }}
        </button>
        <button
          class="btn role-primary"
          :disabled="applying || loadingTargets || nothingToDo"
          @click="apply"
        >
          <i
            v-if="applying"
            class="icon icon-spinner icon-spin"
          />
          Apply
        </button>
      </footer>
    </aside>
  </div>
</template>

<style lang="scss" scoped>
.pp-backdrop { position: fixed; inset: 0; z-index: 899; background: transparent; }
.pp-panel {
  position: fixed; top: 55px; right: 0; width: 900px; max-width: 100vw; height: calc(100vh - 55px);
  background: var(--body-bg); border-left: 1px solid var(--border); display: flex; flex-direction: column; z-index: 900;
}
.pp-header { display: flex; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); }
.pp-title { flex: 1; font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-close { padding: 0; width: 28px; height: 28px; border: none; color: var(--body-text); &:hover { color: var(--primary); } }
.pp-body { flex: 1; overflow-y: auto; padding: 16px; h3 { margin: 20px 0 8px; font-size: 14px; } }
.pp-facts { display: grid; grid-template-columns: 1fr 2fr; gap: 12px; margin: 12px 0 0; dt { font-size: 12px; color: var(--muted); } dd { margin: 0; } }
.pp-plans { list-style: none; padding: 0; margin: 0; li { padding: 6px 0; border-bottom: 1px solid var(--border); } .icon { margin-right: 6px; } }
.pp-log { margin: 0; padding-left: 18px; width: 100%; li { padding: 1px 0; } }
.pp-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
</style>
