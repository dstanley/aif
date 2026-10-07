<script lang="ts" setup>
// The Catalog: everything a user can deploy. Training and inference profiles (governed, into a
// project on this cluster), blueprints (to this or other clusters through Fleet) and apps from the
// app catalog. Each card's Deploy opens the flow that kind already has. In a cluster's AI Jobs
// section it is that cluster's training catalog: its training and test profiles, run there. Each card
// is a compute profile, which an administrator edits from the card's menu. Apps and blueprints are
// deployed centrally, from AI Factory's Apps and Blueprints.
import { computed, getCurrentInstance, onMounted, reactive, ref } from 'vue';
import jsyaml from 'js-yaml';
import Banner from '@components/Banner/Banner.vue';
import ActionMenuShell from '@shell/components/ActionMenuShell.vue';
import Checkbox from '@components/Form/Checkbox/Checkbox.vue';
import BlueprintSourceBadge from '../components/BlueprintSourceBadge.vue';
import BlueprintPartnerLogo from '../components/BlueprintPartnerLogo.vue';
import StatusPill from '../training/components/StatusPill.vue';
import { listBlueprints, groupBlueprintsByFamily, sourceFor } from '../utils/blueprint-api';
import { browserSafeBlueprintIcon, onCatalogLogoError, resolveCatalogLogo } from '../utils/catalog-logo';
import genericLogo from '../assets/generic-app.svg';
import nvidiaLogo from '../assets/nvidia-logo.svg';
import nvidiaLogoDark from '../assets/nvidia-logo-light.svg';
import { fetchStaticCatalog } from '../services/static-catalog';
import { resolveInstallRepoName } from '../services/app-collection';
import { PRODUCT } from '../config/suseai';
import { profilesFrom, Profile } from '../training/profiles';
import { DEPLOY_PAGE, ENDPOINT_PAGE, SUBMIT_PAGE } from '../training/config';
import {
  CatalogApp, CatalogBlueprint, CatalogItem, CatalogKind, CatalogTab, catalogItems, catalogSections, deployLabel, filterCatalog, tabItems
} from '../training/catalog';
import {
  CATALOG_SHOW_APPS, CATALOG_SHOW_WRAPPED, getPref, setPref
} from '../training/prefs';
import { checkOperatorConnection, getConnectionError } from '../utils/operator-config';
import { inClusterSection, trainingLink } from '../training/section';
import { useT } from '../composables/useT';
import { loadClusterLabel } from '../training/cluster';

const vm = getCurrentInstance()!.proxy as any;
const store = vm.$store;
const t = useT();
const cluster = computed(() => String(vm.$route.params.cluster || 'local'));

const TABS: { key: CatalogTab; label: string }[] = [
  { key: '', label: t('suseai.pages.catalog.tabs.all', 'All') },
  { key: 'application', label: t('suseai.pages.catalog.tabs.application', 'Applications') },
  { key: 'training', label: t('suseai.pages.catalog.tabs.training', 'Training') },
  { key: 'inference', label: t('suseai.pages.catalog.tabs.inference', 'Inference') },
  { key: 'blueprint', label: t('suseai.pages.catalog.tabs.blueprint', 'Blueprints') },
];
const KIND_LABEL: Record<CatalogKind, string> = {
  training:    t('suseai.pages.catalog.kinds.training', 'Training'),
  inference:   t('suseai.pages.catalog.kinds.inference', 'Inference'),
  application: t('suseai.pages.catalog.kinds.application', 'Application'),
};

const loading = ref(true);
const error = ref('');
const profiles = ref<Profile[]>([]);
const blueprints = ref<CatalogBlueprint[]>([]);
const apps = ref<CatalogApp[]>([]);
// the version each blueprint card deploys, as on the Blueprints page; newest by default
const selectedVersions = reactive<Record<string, string>>({});
const filter = ref({ text: '', status: '' as '' | 'ready' | 'beta' });

// a cluster's AI Jobs section: its training catalog, no tabs
const clusterSection = inClusterSection(vm.$route);
// whether this user may write the cluster's profiles (ConfigMaps in ai-profiles), for Edit and New
const canEditProfiles = ref(false);
const tab = computed<CatalogTab>(() => {
  if (clusterSection) {
    return 'training';
  }
  const t = String(vm.$route.query.tab || '');

  return (TABS.some((tb) => tb.key === t) ? t : '') as CatalogTab;
});
const showWrapped = computed(() => getPref(CATALOG_SHOW_WRAPPED.key, CATALOG_SHOW_WRAPPED.def));
const showApps = computed({
  get: () => getPref(CATALOG_SHOW_APPS.key, CATALOG_SHOW_APPS.def),
  set: (value: boolean) => setPref(CATALOG_SHOW_APPS.key, CATALOG_SHOW_APPS.def, value),
});
const items = computed(() => catalogItems(profiles.value, blueprints.value, showWrapped.value, showApps.value ? apps.value : []));
const visible = computed(() => filterCatalog(tabItems(tab.value, items.value, blueprints.value), '', filter.value));
// tests and benchmarks under their own heading; one untitled section when there are none
const sections = computed(() => catalogSections(visible.value));
// the tests and benchmarks section starts closed: occasional, and it would push the rest down
const openSections = reactive<Record<string, boolean>>({});
const isOpen = (s: { key: string; collapsible: boolean }) => !s.collapsible || !!openSections[s.key] || !!filter.value.text;
const countOf = (k: CatalogTab) => tabItems(k, items.value, blueprints.value).length;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    if (clusterSection) {
      profiles.value = profilesFrom(await store.dispatch('cluster/findAll', { type: 'configmap', opt: { force: true } }), (s: string) => jsyaml.load(s));

      return;
    }
    // the operator API (blueprints, the app catalog) needs its connection resolved first
    await checkOperatorConnection();
    const operatorError = getConnectionError();
    const failed: string[] = [];
    const note = (what: string, fallback: any) => (e: any) => {
      failed.push(`${ what }: ${ e?.message || e }`);

      return fallback;
    };
    const [cms, bps, catalog] = await Promise.all([
      store.dispatch('cluster/findAll', { type: 'configmap', opt: { force: true } }).catch(note('profiles', [])),
      operatorError ? Promise.resolve({ items: [] }) : listBlueprints().catch(note('blueprints', { items: [] })),
      operatorError ? Promise.resolve([]) : fetchStaticCatalog().catch(note('apps', [])),
    ]);

    if (operatorError) {
      failed.push(`${ t('suseai.pages.catalog.operator', 'AI Factory operator') }: ${ operatorError }`);
    }
    if (failed.length) {
      error.value = t('suseai.pages.catalog.partialError', 'Some of the catalog could not be loaded. {errors}', { errors: failed.join('; ') });
    }

    apps.value = (catalog || []).map((a: any) => ({
      slug:           String(a.slug_name),
      name:           String(a.name || a.slug_name),
      description:    String(a.description || ''),
      logo:           String(a.logo_url || ''),
      library:        String(a.library || ''),
      repositoryName: String(a.repository_name || ''),
      repositoryUrl:  String(a.repository_url || ''),
    }));

    profiles.value = profilesFrom(cms, (s: string) => jsyaml.load(s));
    const out: CatalogBlueprint[] = [];

    for (const [family, versions] of groupBlueprintsByFamily(bps.items || []).entries()) {
      const active = versions.filter((b: any) => !b.spec.deprecated);
      const b: any = active[0];

      if (!b) {
        continue;
      }
      out.push({
        family,
        displayName: String(b.spec.displayName || family),
        version:     String(b.spec.version || ''),
        versions:    active.map((v: any) => String(v.spec.version || '')),
        description: String(b.spec.description || ''),
        category:    String(b.spec.category || ''),
        components:  (b.spec.components || []).length,
        source:      String(sourceFor(b)),
        icon:        browserSafeBlueprintIcon(b.spec.icon),
      });
      if (!selectedVersions[family]) {
        selectedVersions[family] = String(b.spec.version || '');
      }
    }
    blueprints.value = out;
  } catch (e: any) {
    error.value = t('suseai.pages.catalog.loadError', 'Could not load the catalog: {error}', { error: String(e?.message || e) });
  } finally {
    loading.value = false;
  }
}
const clusterName = ref('');

onMounted(() => {
  load();
  if (clusterSection) {
    checkProfileAccess();
  }
  loadClusterLabel(store, cluster.value).then((l) => {
    clusterName.value = l;
  });
});

const tabRoute = (key: string) => ({ query: key ? { tab: key } : {} });

function deployRoute(i: CatalogItem): any {
  if (i.profile) {
    return trainingLink(vm.$route, i.profile.type === 'inference' ? ENDPOINT_PAGE : DEPLOY_PAGE, { profile: i.profile.name });
  }

  return blueprintInstall(i.blueprint!);
}
function blueprintInstall(b: CatalogBlueprint): any {
  return { name: `c-cluster-${ PRODUCT }-blueprint-install`, params: { cluster: cluster.value }, query: { name: b.family, version: selectedVersions[b.family] || b.version } };
}
// as clicking the app on the Apps page: its install wizard, with the repository it installs from
async function deployApp(a: CatalogApp) {
  const repo = await resolveInstallRepoName(store, { repository_name: a.repositoryName || undefined, repository_url: a.repositoryUrl || undefined }).catch(() => null);

  vm.$router.push({
    name: `c-cluster-${ PRODUCT }-install`, params: { cluster: cluster.value, slug: a.slug }, query: { n: a.name, ...(repo ? { repo } : {}) }
  });
}
// App and blueprint icons as the Apps and Blueprints pages resolve them: the catalog's logo, else
// the bundled one for that app, else a generic icon; NVIDIA's apps get the NVIDIA logo.
const appLogo = (a: CatalogApp) => resolveCatalogLogo({ logo_url: a.logo, library: a.library, slug_name: a.slug } as any) || genericLogo;
const onAppLogoError = (e: Event, a: CatalogApp) => onCatalogLogoError(e, { logo_url: a.logo, library: a.library, slug_name: a.slug } as any, genericLogo);
const appsRoute = computed(() => ({ name: `c-cluster-${ PRODUCT }-apps`, params: { cluster: cluster.value } }));
function actions(i: CatalogItem): any[] {
  if (clusterSection) {
    return canEditProfiles.value && i.profile ? [{ action: 'edit', label: t('suseai.pages.catalog.editProfile', 'Edit profile'), enabled: true }] : [];
  }

  return i.wraps ? [{ action: 'fleet', label: t('suseai.pages.catalog.deployToClusters', 'Deploy to other clusters…'), enabled: true }] : [];
}
function onAction(payload: { action: string }, i: CatalogItem) {
  if (payload.action === 'fleet' && i.wraps) {
    vm.$router.push(blueprintInstall(i.wraps));
  }
  if (payload.action === 'edit' && i.profile) {
    vm.$router.push(trainingLink(vm.$route, SUBMIT_PAGE, { authorProfile: i.profile.name }));
  }
}
// a new training profile: the full form, in profile-authoring mode
const newProfileRoute = computed(() => trainingLink(vm.$route, SUBMIT_PAGE, { authorProfile: 'new' }));

/** A SelfSubjectAccessReview: may this user create ConfigMaps in this cluster's ai-profiles? */
async function checkProfileAccess() {
  try {
    const res = await store.dispatch('cluster/request', {
      url:    `/k8s/clusters/${ encodeURIComponent(cluster.value) }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`,
      method: 'POST',
      data:   {
        apiVersion: 'authorization.k8s.io/v1',
        kind:       'SelfSubjectAccessReview',
        spec:       { resourceAttributes: { verb: 'create', resource: 'configmaps', namespace: 'ai-profiles' } },
      },
    });

    canEditProfiles.value = !!res?.status?.allowed;
  } catch {
    canEditProfiles.value = false;
  }
}
function scope(i: CatalogItem): string {
  return i.from === 'profile' ? t('suseai.pages.catalog.scope.profile', 'Runs on {cluster}', { cluster: clusterName.value || cluster.value }) : i.from === 'blueprint' ? t('suseai.pages.catalog.scope.blueprint', 'Any cluster') : '';
}
// catalog.ts names sections and buttons in English (its tests read them); the page translates them
const sectionTitle = (s: { key: string; title: string }) => (s.title ? t(`suseai.pages.catalog.sections.${ s.key }`, s.title) : '');
const deployText = (i: CatalogItem) => t(`suseai.pages.catalog.deploy.${ i.purpose === 'test' || i.purpose === 'benchmark' ? i.purpose : i.kind === 'training' ? 'job' : 'run' }`, deployLabel(i));
</script>

<template>
  <main class="main-layout">
    <div class="outlet">
      <header class="fixed-header">
        <h1>
          {{ t('suseai.pages.catalog.title', 'Catalog') }}
          <span
            v-if="clusterSection && clusterName"
            class="text-muted catalog-cluster"
          >· {{ clusterName }}</span>
        </h1>
        <div
          class="actions-container"
          role="toolbar"
        >
          <div class="search-box">
            <input
              v-model="filter.text"
              type="search"
              :placeholder="t('suseai.pages.catalog.search', 'Search the catalog')"
              class="input-sm"
              :aria-label="t('suseai.pages.catalog.search', 'Search the catalog')"
            >
          </div>
          <select
            v-model="filter.status"
            class="sort-select form-control-sm"
            :aria-label="t('suseai.common.labels.status', 'Status')"
          >
            <option value="">
              {{ t('suseai.pages.catalog.status.all', 'All statuses') }}
            </option>
            <option value="ready">
              {{ t('suseai.pages.catalog.status.ready', 'Ready') }}
            </option>
            <option value="beta">
              {{ t('suseai.pages.catalog.status.beta', 'Beta') }}
            </option>
          </select>
          <Checkbox
            v-if="!clusterSection && (!tab || tab === 'application')"
            v-model:value="showApps"
            :label="t('suseai.pages.catalog.showApps', 'Show apps')"
          />
          <router-link
            v-if="clusterSection && canEditProfiles"
            :to="newProfileRoute"
            class="btn role-secondary ml-auto"
          >
            <i class="icon icon-plus" /> {{ t('suseai.pages.catalog.newProfile', 'New profile') }}
          </router-link>
          <button
            :class="['btn role-secondary', { 'ml-auto': !(clusterSection && canEditProfiles) }]"
            type="button"
            :disabled="loading"
            @click="load"
          >
            <i :class="['icon', loading ? 'icon-spinner icon-spin' : 'icon-refresh']" />
            {{ t('suseai.common.actions.refresh', 'Refresh') }}
          </button>
        </div>
      </header>

      <nav
        v-if="!clusterSection"
        class="catalog-tabs"
        :aria-label="t('suseai.pages.catalog.sectionsLabel', 'Catalog sections')"
      >
        <router-link
          v-for="tb in TABS"
          :key="tb.key"
          :to="tabRoute(tb.key)"
          :class="['catalog-tab', { active: tab === tb.key }]"
        >
          {{ tb.label }} <span class="tab-count">{{ countOf(tb.key) }}</span>
        </router-link>
      </nav>

      <Banner
        v-if="error"
        color="error"
        :label="error"
      />

      <template v-if="visible.length">
        <section
          v-for="section in sections"
          :key="section.key"
          class="catalog-section"
        >
          <h2
            v-if="section.title && !section.collapsible"
            class="section-title"
          >
            {{ sectionTitle(section) }}
          </h2>
          <button
            v-else-if="section.collapsible"
            type="button"
            class="section-toggle"
            :aria-expanded="isOpen(section)"
            @click="openSections[section.key] = !isOpen(section)"
          >
            <i :class="['icon', isOpen(section) ? 'icon-chevron-down' : 'icon-chevron-right']" />
            {{ sectionTitle(section) }}
            <span class="tab-count">{{ section.items.length }}</span>
            <span class="text-muted section-hint">{{ t('suseai.pages.catalog.sections.validateHint', 'GPU, PyTorch, distributed, network and storage checks') }}</span>
          </button>
          <div
            v-if="isOpen(section)"
            class="tiles-grid"
            role="grid"
          >
            <div
              v-for="i in section.items"
              :key="i.key"
              class="app-tile"
            >
              <div class="tile-header">
                <div class="tile-info">
                  <div class="tile-title-row">
                    <template v-if="i.app && i.app.library === 'nvidia'">
                      <img
                        :src="nvidiaLogo"
                        alt=""
                        class="tile-logo nvidia-logo--light"
                      >
                      <img
                        :src="nvidiaLogoDark"
                        alt=""
                        class="tile-logo nvidia-logo--dark"
                      >
                    </template>
                    <img
                      v-else-if="i.app"
                      :src="appLogo(i.app)"
                      alt=""
                      class="tile-logo"
                      @error="onAppLogoError($event, i.app)"
                    >
                    <img
                      v-else-if="i.blueprint"
                      :src="i.blueprint.icon || genericLogo"
                      alt=""
                      class="tile-logo"
                    >
                    <h3 class="tile-title">
                      {{ i.title }}
                    </h3>
                    <StatusPill
                      v-if="i.from === 'profile'"
                      :status="i.status"
                    />
                    <select
                      v-if="i.blueprint && i.blueprint.versions.length"
                      v-model="selectedVersions[i.blueprint.family]"
                      class="version-select form-control-sm"
                      :aria-label="t('suseai.common.labels.version', 'Version')"
                    >
                      <option
                        v-for="v in i.blueprint.versions"
                        :key="v"
                        :value="v"
                      >
                        v{{ v }}
                      </option>
                    </select>
                  </div>
                  <div class="tile-meta">
                    <span class="kind-chip">{{ KIND_LABEL[i.kind] }}</span>
                    <template
                      v-for="m in i.meta"
                      :key="m"
                    >
                      <span class="tile-meta-sep">·</span>
                      <span>{{ m }}</span>
                    </template>
                    <template v-if="i.blueprint">
                      <span class="tile-meta-sep">·</span>
                      <BlueprintSourceBadge :source="i.blueprint.source" />
                      <BlueprintPartnerLogo :icon="i.blueprint.icon" />
                    </template>
                  </div>
                </div>
              </div>
              <div class="tile-content">
                <p class="tile-description">
                  {{ i.description || '—' }}
                </p>
              </div>
              <div class="tile-footer">
                <button
                  v-if="i.app"
                  type="button"
                  class="btn role-primary btn-sm"
                  @click="deployApp(i.app)"
                >
                  {{ t('suseai.pages.catalog.deploy.run', 'Deploy') }}
                </button>
                <router-link
                  v-else
                  :to="deployRoute(i)"
                  class="btn role-primary btn-sm"
                >
                  {{ deployText(i) }}
                </router-link>
                <span class="tile-scope text-muted">{{ scope(i) }}</span>
                <div
                  v-if="actions(i).length"
                  class="tile-menu"
                >
                  <ActionMenuShell
                    button-variant="tertiary"
                    :button-aria-label="t('suseai.pages.catalog.moreOptions', 'More options')"
                    :custom-actions="actions(i)"
                    @action-invoked="onAction($event, i)"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>
      </template>
      <p
        v-if="!visible.length && !loading"
        class="text-muted"
      >
        {{ t('suseai.pages.catalog.empty', 'Nothing in the catalog matches.') }}
      </p>

      <!-- The full app catalog (libraries, custom repositories, repository health) is the Apps page. -->
      <p
        v-if="showApps && (!tab || tab === 'application')"
        class="catalog-apps-link"
      >
        <router-link :to="appsRoute">
          {{ t('suseai.pages.catalog.browseApps', 'Browse all apps, by library and repository') }} <i class="icon icon-chevron-right" />
        </router-link>
      </p>
    </div>
  </main>
</template>

<style lang="scss" scoped>
.fixed-header {
  margin-bottom: 20px;
  .actions-container {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    .search-box .input-sm {
      width: 240px;
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
}
.catalog-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
.catalog-tab {
  padding: 8px 16px;
  border-bottom: 2px solid transparent;
  color: var(--body-text);
  text-decoration: none;
  &.active { border-bottom-color: var(--primary); color: var(--primary); }
}
.catalog-cluster { font-size: 0.7em; font-weight: normal; }
.tab-count { font-size: 11px; padding: 0 6px; border-radius: 8px; background: var(--border); color: var(--body-text); margin-left: 4px; }
// auto-fill keeps the columns when a row is short, so cards keep one width without filler tiles
.tiles-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
.app-tile {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px;
  gap: 12px;
  min-height: 200px;
  transition: border-color 0.2s ease;
  &:hover { border-color: var(--primary); }
  .tile-info { flex: 1; }
  .tile-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .tile-title { margin: 0; font-size: 14px; font-weight: 600; }
  .tile-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); margin-top: 4px; }
  .tile-meta-sep { opacity: 0.5; }
  .kind-chip { font-weight: 600; color: var(--body-text); }
  .tile-content { flex: 1; }
  .tile-description {
    margin: 0;
    font-size: 14px;
    color: var(--body-text);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .tile-footer { display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
  .tile-scope { font-size: 12px; }
  .tile-menu { margin-left: auto; }
}
.catalog-apps-link { margin-top: 20px; }
.catalog-section + .catalog-section { margin-top: 28px; }
.section-title { font-size: 16px; margin: 0 0 12px; }
.section-toggle {
  display: flex; align-items: center; gap: 8px; margin: 0 0 12px; padding: 0;
  background: none; border: 0; font: inherit; font-size: 16px; font-weight: 600; color: var(--body-text); cursor: pointer;
  .icon { font-size: 12px; color: var(--muted); }
  &:focus:not(:focus-visible) { outline: none; }
}
.section-hint { font-size: 13px; font-weight: 400; }
.tile-logo { width: 36px; height: 36px; object-fit: contain; flex-shrink: 0; }
:global(body:not(.theme-dark) .nvidia-logo--dark) { display: none; }
:global(body.theme-dark .nvidia-logo--light) { display: none; }
.app-tile .tile-title { flex: 1; }
.version-select {
  font-size: 12px;
  height: 26px;
  padding: 0 4px 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  background: var(--input-bg);
  color: var(--body-text);
  width: auto;
  flex-shrink: 0;
  max-width: 120px;
}
</style>
