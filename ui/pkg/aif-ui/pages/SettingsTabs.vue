<script lang="ts" setup>
// Settings: what an administrator configures, one tab each. General (registries, repositories,
// Fleet), Projects & Quotas (who may use how much GPU), Blueprints (authoring and catalog sources)
// and Compute Profiles (the training and inference configurations the Catalog offers). The tab is in
// the URL, so a link opens it.
import { computed, getCurrentInstance } from 'vue';
import Checkbox from '@components/Form/Checkbox/Checkbox.vue';
import Settings from './Settings.vue';
import Blueprints from './Blueprints.vue';
import Projects from '../training/pages/Projects.vue';
import Profiles from '../training/pages/Profiles.vue';
import { CATALOG_SHOW_WRAPPED, getPref, setPref } from '../training/prefs';

const vm = getCurrentInstance()!.proxy as any;
// Rancher's t() HTML-escapes and Vue escapes again, so labels are read raw: & would show as &amp;
const TABS = [
  { key: '', labelKey: 'suseai.pages.settings.tabs.general' },
  { key: 'projects', labelKey: 'suseai.pages.settings.tabs.projects' },
  { key: 'blueprints', labelKey: 'suseai.pages.settings.tabs.blueprints' },
  { key: 'profiles', labelKey: 'suseai.pages.settings.tabs.profiles' },
];
const tab = computed(() => (TABS.some((t) => t.key === vm.$route.query.tab) ? String(vm.$route.query.tab) : ''));
const showWrapped = computed({
  get: () => getPref(CATALOG_SHOW_WRAPPED.key, CATALOG_SHOW_WRAPPED.def),
  set: (value: boolean) => setPref(CATALOG_SHOW_WRAPPED.key, CATALOG_SHOW_WRAPPED.def, value),
});
</script>

<template>
  <main class="settings-tabs">
    <h1>{{ t('suseai.pages.settings.title') }}</h1>
    <nav
      class="st-tabs"
      :aria-label="t('suseai.pages.settings.tabs.label')"
    >
      <router-link
        v-for="tb in TABS"
        :key="tb.key"
        :to="{ query: tb.key ? { tab: tb.key } : {} }"
        :class="['st-tab', { active: tab === tb.key }]"
      >
        {{ t(tb.labelKey, {}, true) }}
      </router-link>
    </nav>
    <Projects
      v-if="tab === 'projects'"
      embedded
    />
    <template v-else-if="tab === 'blueprints'">
      <div class="st-option">
        <Checkbox
          v-model:value="showWrapped"
          :label="t('suseai.pages.settings.showWrapped.label', {}, true)"
        />
        <p class="text-muted">
          {{ t('suseai.pages.settings.showWrapped.help', {}, true) }}
        </p>
      </div>
      <Blueprints embedded />
    </template>
    <Profiles
      v-else-if="tab === 'profiles'"
      embedded
    />
    <Settings
      v-else
      embedded
    />
  </main>
</template>

<style lang="scss" scoped>
.st-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin: 8px 0 16px;
}
.st-tab {
  padding: 8px 16px;
  border-bottom: 2px solid transparent;
  color: var(--body-text);
  text-decoration: none;

  &.active {
    border-bottom-color: var(--primary);
    color: var(--primary);
  }
}
.st-option {
  margin-bottom: 20px;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  p { margin: 4px 0 0 24px; font-size: 13px; }
}
</style>
