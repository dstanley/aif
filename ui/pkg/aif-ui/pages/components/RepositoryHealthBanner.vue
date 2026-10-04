<script>
// Repository health. The full form (Apps) lists each unavailable repository with its message; the
// compact form (Overview) is a one-line advisory, since existing workloads are not affected, with
// the details (reason, next retry) behind "View details" and a dismiss that lasts until the set of
// unavailable repositories changes.
const RETRY = /\.?\s*Will retry after ([0-9hms.]+)\.?\s*$/i;

export default {
  name:  'RepositoryHealthBanner',
  props: {
    repositories: { type: Array, default: () => [] },
    error:        { type: String, default: '' },
    messages:     { type: Array, default: () => [] },
    compact:      { type: Boolean, default: false },
  },
  data() {
    return { open: false, dismissed: '' };
  },
  computed: {
    unavailable() {
      return this.repositories.filter((repo) => !repo.ready);
    },
    settingsLink() {
      return { name: 'c-cluster-suseai-settings', params: { cluster: this.$route?.params?.cluster || 'local' } };
    },
    /** What the advisory is about; a dismissal holds until this changes. */
    signature() {
      return this.error ? `error:${ this.error }` : this.unavailable.map((r) => r.name).sort().join(',');
    },
    shown() {
      const any = !!(this.error || this.unavailable.length || this.messages.length);

      return any && !(this.compact && this.dismissed === this.signature);
    },
    details() {
      return this.unavailable.map((repo) => {
        const m = (repo.message || '').match(RETRY);
        const reason = (repo.message || '').replace(RETRY, '').trim();

        return {
          name:   repo.name,
          label:  repo.displayName || repo.name,
          reason: reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : this.t('suseai.repositoryHealth.pending'),
          retry:  m ? m[1] : '',
          link:   `/c/local/apps/catalog.cattle.io.clusterrepo/${ encodeURIComponent(repo.name) }`,
        };
      });
    },
  },
  methods: {
    repoLink(repo) {
      return `/c/local/apps/catalog.cattle.io.clusterrepo/${ encodeURIComponent(repo.name) }`;
    },
  },
};
</script>

<template>
  <div
    v-if="shown && compact"
    class="repository-advisory"
    role="status"
  >
    <div class="ra-line">
      <i class="icon icon-warning" />
      <strong v-if="error">{{ t('suseai.repositoryHealth.unknown') }}</strong>
      <strong v-else>{{ t('suseai.repositoryHealth.compactTitle', { count: unavailable.length }) }}</strong>
      <button
        type="button"
        class="btn-link"
        :aria-expanded="open"
        @click="open = !open"
      >
        {{ t(open ? 'suseai.repositoryHealth.hideDetails' : 'suseai.repositoryHealth.viewDetails') }}
      </button>
      <span class="ra-grow" />
      <button
        type="button"
        class="ra-dismiss"
        :aria-label="t('suseai.repositoryHealth.dismiss')"
        @click="dismissed = signature"
      >
        <i class="icon icon-close" />
      </button>
    </div>
    <div
      v-if="open"
      class="ra-details"
    >
      <p v-if="error">
        {{ error }}
      </p>
      <dl
        v-for="d in details"
        :key="d.name"
      >
        <dt class="ra-repo">
          {{ d.label }}
        </dt>
        <dd>
          <span>{{ t('suseai.repositoryHealth.impact') }}</span>
          <span>{{ d.reason }}<template v-if="d.retry"> · {{ t('suseai.repositoryHealth.nextRetry', { after: d.retry }) }}</template></span>
        </dd>
        <dd>
          <router-link :to="d.link">
            {{ t('suseai.repositoryHealth.checkRepository') }}
          </router-link>
        </dd>
      </dl>
      <router-link :to="settingsLink">
        {{ t('suseai.repositoryHealth.settings') }}
      </router-link>
    </div>
  </div>

  <div
    v-else-if="shown"
    class="repository-health"
    role="status"
  >
    <strong>{{ t(error ? 'suseai.repositoryHealth.unknown' : 'suseai.repositoryHealth.title') }}</strong>
    <p v-if="error">
      {{ error }}
    </p>
    <ul v-else>
      <li
        v-for="repo in unavailable"
        :key="repo.name"
      >
        <router-link :to="repoLink(repo)">
          {{ repo.name }}
        </router-link>
        <span> — {{ repo.message || t('suseai.repositoryHealth.pending') }}</span>
      </li>
      <li
        v-for="message in messages"
        :key="message"
      >
        {{ message }}
      </li>
    </ul>
    <p>
      {{ t('suseai.repositoryHealth.guidance') }} <router-link :to="settingsLink">
        {{ t('suseai.repositoryHealth.settings') }}
      </router-link>
    </p>
  </div>
</template>

<style lang="scss" scoped>
.repository-health {
  padding: 12px 16px;
  margin-bottom: 20px;
  border: 1px solid var(--warning);
  border-radius: var(--border-radius);
  background: var(--warning-banner-bg);
  overflow-wrap: anywhere;
  p { margin: 8px 0 0; }
  ul { margin: 8px 0; padding-left: 20px; }
}
.repository-advisory {
  margin-bottom: 16px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--warning);
  border-radius: var(--border-radius);
  font-size: 13px;
}
.ra-line {
  display: flex;
  align-items: center;
  gap: 10px;

  .icon-warning { color: var(--warning); }
}
.ra-grow { flex: 1; }
.btn-link, .ra-dismiss {
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  color: var(--link);
  font-size: 13px;
}
.ra-dismiss { color: var(--muted); }
.ra-details {
  padding: 8px 0 4px 26px;
  overflow-wrap: anywhere;

  dl { margin: 0 0 8px; }
  dd { margin: 2px 0 0; display: flex; flex-direction: column; color: var(--muted); }
  .ra-repo { font-weight: 600; }
  p { margin: 0 0 8px; }
}
</style>
