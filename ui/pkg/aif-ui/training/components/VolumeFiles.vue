<script lang="ts">
// The files on a volume, one folder at a time, each with a download. Opening the volume reads an index
// of it in one short-lived Job (see volumefiles.ts): when every file fits, moving between folders,
// sorting and searching then happen in the browser with no further Job. A larger volume is read one
// folder at a time, its files sorted on the volume and cut at MAX_ENTRIES, which the listing says.
// Every folder is in a jump list either way. A file too big to download here gets the command that
// copies it instead.
import { defineComponent, PropType } from 'vue';
import type { CheckpointVolume } from '../checkpoints';
import {
  FolderListing, FolderSort, MAX_DOWNLOAD_BYTES, MAX_ENTRIES, VolumeFile, VolumeFolder, VolumeIndex, decodeFile, fileScript, folderScript, formatBytes,
  indexScript, listFromIndex, parseFolder, parseIndex, runVolumeJob
} from '../volumefiles';
import { checkpointRun } from '../checkpoints';

export default defineComponent({
  name:  'VolumeFiles',
  props: { checkpoint: { type: Object as PropType<CheckpointVolume>, required: true } },

  data() {
    return {
      loading:   true,
      error:     '',
      dir:       '',
      listing:   null as FolderListing | null,
      index:     null as VolumeIndex | null, // the whole volume, read when it opens
      sort:      'name' as FolderSort,
      filter:    '',
      applied:   '', // the filter the listing shown was read with
      busy:      '' as string,
      fileError: '' as string,
      copied:    '' as string,
    };
  },

  computed: {
    cluster(): string {
      return String(this.$route.params.cluster || 'local');
    },
    folders(): VolumeFolder[] {
      return this.listing?.folders || [];
    },
    files(): VolumeFile[] {
      return this.listing?.files || [];
    },
    crumbs(): { name: string; dir: string }[] {
      const parts = this.dir ? this.dir.split('/') : [];

      return parts.map((name: string, i: number) => ({ name, dir: parts.slice(0, i + 1).join('/') }));
    },
    cut(): boolean {
      return !!this.listing && this.listing.totalFiles > this.files.length;
    },
    max: () => MAX_ENTRIES,
  },

  mounted() {
    this.refresh();
  },

  methods: {
    /** Read the volume's index, then show the folder. */
    async refresh() {
      this.loading = true;
      this.error = '';
      try {
        this.index = parseIndex(await runVolumeJob(this.$store, this.cluster, this.checkpoint.namespace, this.checkpoint.name, indexScript()));
        if (this.dir && !this.index.dirs.includes(this.dir) && this.index.complete) {
          this.dir = '';
        }
      } catch (e: any) {
        this.error = this.explain(e);
        this.loading = false;

        return;
      }
      await this.show();
    },

    /** The folder shown: from the index when it holds everything (no Job), else read on its own. */
    async show() {
      if (this.index?.complete) {
        this.listing = listFromIndex(this.index, this.dir, this.sort, this.filter);
        this.applied = this.filter.trim();
        this.fileError = '';
        this.loading = false;

        return;
      }
      await this.load();
    },

    async load() {
      this.loading = true;
      this.error = '';
      this.fileError = '';
      const filter = this.filter.trim();

      try {
        const log = await runVolumeJob(this.$store, this.cluster, this.checkpoint.namespace, this.checkpoint.name, folderScript(this.dir, { sort: this.sort, filter }));

        this.listing = parseFolder(log, this.dir, this.sort);
        this.applied = filter;
      } catch (e: any) {
        this.error = this.explain(e);
      } finally {
        this.loading = false;
      }
    },

    open(dir: string) {
      this.dir = dir;
      this.filter = '';
      this.show();
    },

    setSort(s: FolderSort) {
      this.sort = s;
      this.show();
    },

    clearFilter() {
      this.filter = '';
      this.show();
    },

    /** The file's path within the folder shown (a search shows paths under it). */
    shownPath(f: VolumeFile): string {
      return this.dir && f.path.startsWith(`${ this.dir }/`) ? f.path.slice(this.dir.length + 1) : f.path;
    },

    /** How to copy a file too big for the browser: the CLI for a run's checkpoint volume, kubectl cp otherwise. */
    copyCommand(f: VolumeFile): string {
      if (checkpointRun(this.checkpoint.obj) || this.checkpoint.name.endsWith('-checkpoints')) {
        return `rancher-ai -p ${ this.checkpoint.namespace } checkpoints get ${ this.checkpoint.name } ${ f.path } ./`;
      }

      return `# mount ${ this.checkpoint.name } in a pod in ${ this.checkpoint.namespace }, then: kubectl -n ${ this.checkpoint.namespace } cp <pod>:<mount path>/${ f.path } ./`;
    },

    async copy(text: string) {
      try {
        await navigator.clipboard.writeText(text);
        this.copied = text;
        setTimeout(() => {
          if (this.copied === text) {
            this.copied = '';
          }
        }, 2500);
      } catch (e) {
        this.copied = '';
      }
    },

    async download(f: VolumeFile) {
      this.copied = '';
      this.busy = f.path;
      this.fileError = '';
      try {
        const d = decodeFile(await runVolumeJob(this.$store, this.cluster, this.checkpoint.namespace, this.checkpoint.name, fileScript(f.path)));

        if (!d.ok) {
          this.fileError = d.reason === 'missing' ? `${ f.path } is no longer on the volume.` : d.reason === 'too-big' ? this.tooBig(f) : `Copying ${ f.path } did not complete; try again.`;

          return;
        }
        const url = URL.createObjectURL(new Blob([d.bytes], { type: 'application/octet-stream' }));
        const a = document.createElement('a');

        a.href = url;
        a.download = f.path.split('/').pop() || 'file';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e: any) {
        this.fileError = this.explain(e);
      } finally {
        this.busy = '';
      }
    },

    canDownload(f: VolumeFile): boolean {
      return f.size <= MAX_DOWNLOAD_BYTES;
    },

    tooBig(f: VolumeFile): string {
      return `${ f.path } is ${ formatBytes(f.size) }; downloads here are limited to ${ formatBytes(MAX_DOWNLOAD_BYTES) }. Copy it with the command beside it.`;
    },

    explain(e: any): string {
      const status = e?._status || e?.status || e?.response?.status;
      const msg = e?.message || e?.data?.message || String(e);

      return status === 403 ? `You cannot create Jobs in ${ this.checkpoint.namespace }, which reading the volume needs (AI Job Submitter allows it).` : msg;
    },

    formatBytes(n: number): string {
      return formatBytes(n);
    },

    when(d: Date | null): string {
      return d ? d.toLocaleString() : '—';
    },
  },
});
</script>

<template>
  <div class="vf">
    <div class="vf-bar">
      <nav
        class="vf-crumbs"
        aria-label="Folder"
      >
        <a
          href="#"
          @click.prevent="open('')"
        >{{ checkpoint.name }}</a>
        <template
          v-for="c in crumbs"
          :key="c.dir"
        >
          <span class="text-muted">/</span>
          <a
            href="#"
            @click.prevent="open(c.dir)"
          >{{ c.name }}</a>
        </template>
      </nav>
      <select
        v-if="index && index.dirs.length"
        :value="dir"
        aria-label="Jump to folder"
        class="vf-jump"
        @change="open($event.target.value)"
      >
        <option value="">
          / (top of the volume)
        </option>
        <option
          v-for="p in index.dirs"
          :key="p"
          :value="p"
        >
          {{ p }}/
        </option>
      </select>
      <form
        class="vf-filter"
        @submit.prevent="show"
      >
        <input
          v-model="filter"
          type="search"
          class="input-sm"
          placeholder="Find files under this folder"
          aria-label="Find files by name"
        >
      </form>
      <select
        :value="sort"
        aria-label="Sort"
        @change="setSort($event.target.value)"
      >
        <option value="name">
          By name
        </option>
        <option value="size">
          Largest first
        </option>
        <option value="modified">
          Newest first
        </option>
      </select>
      <button
        v-clean-tooltip="'Read the volume again'"
        class="btn role-tertiary btn-sm"
        type="button"
        aria-label="Refresh"
        :disabled="loading"
        @click="refresh"
      >
        <i class="icon icon-refresh" />
      </button>
    </div>
    <p
      v-if="index && !index.complete && !loading"
      class="text-muted vf-note"
    >
      This volume holds {{ index.totalFiles }} files, more than can be read at once: each folder is read when you open it.
    </p>

    <div
      v-if="loading"
      class="text-muted"
    >
      <i class="icon icon-spinner icon-spin" /> Reading {{ index ? (dir || checkpoint.name) : checkpoint.name }}… (a short-lived pod mounts the volume read-only)
    </div>
    <div
      v-else-if="error"
      class="text-error"
    >
      {{ error }}
      <button
        class="btn role-tertiary btn-sm"
        type="button"
        @click="refresh"
      >
        Retry
      </button>
    </div>
    <template v-else-if="listing">
      <p
        v-if="listing.search"
        class="text-muted vf-note"
      >
        {{ listing.totalFiles }} file{{ listing.totalFiles === 1 ? '' : 's' }} under {{ dir || 'the volume' }} with “{{ applied }}” in the name<template v-if="cut">
          · showing the first {{ files.length }}
        </template>
        · <a
          href="#"
          @click.prevent="clearFilter"
        >Clear</a>
      </p>
      <p
        v-else-if="cut"
        class="text-muted vf-note"
      >
        Showing {{ files.length }} of {{ listing.totalFiles }} files in this folder ({{ sort === 'name' ? 'by name' : sort === 'size' ? 'largest first' : 'newest first' }}). Find files by name to narrow it.
      </p>
      <p
        v-if="!folders.length && !files.length"
        class="text-muted"
      >
        {{ listing.search ? 'No file names match.' : 'This folder is empty.' }}
      </p>
      <table
        v-else
        class="vf-table"
      >
        <tr
          v-if="dir && !listing.search"
          class="vf-folder"
        >
          <td colspan="4">
            <a
              href="#"
              @click.prevent="open(dir.split('/').slice(0, -1).join('/'))"
            ><i class="icon icon-chevron-up" /> ..</a>
          </td>
        </tr>
        <tr
          v-for="f in listing.search ? [] : folders"
          :key="'d/' + f.name"
          class="vf-folder"
        >
          <td class="vf-path">
            <a
              href="#"
              @click.prevent="open(dir ? `${ dir }/${ f.name }` : f.name)"
            ><i class="icon icon-folder" /> {{ f.name }}/</a>
          </td>
          <td class="text-muted">
            {{ formatBytes(f.bytes) }}
          </td>
          <td class="text-muted">
            {{ f.files }} file{{ f.files === 1 ? '' : 's' }}
          </td>
          <td />
        </tr>
        <tr
          v-for="f in files"
          :key="f.path"
        >
          <td class="vf-path">
            {{ shownPath(f) }}
          </td>
          <td class="text-muted">
            {{ formatBytes(f.size) }}
          </td>
          <td class="text-muted">
            {{ when(f.modified) }}
          </td>
          <td class="vf-right">
            <button
              v-if="canDownload(f)"
              class="btn role-tertiary btn-sm"
              type="button"
              :disabled="!!busy"
              :title="`Download ${ f.path }`"
              @click="download(f)"
            >
              <i :class="['icon', busy === f.path ? 'icon-spinner icon-spin' : 'icon-download']" /> Download
            </button>
            <button
              v-else
              class="btn role-tertiary btn-sm"
              type="button"
              :title="`${ tooBig(f) } ${ copyCommand(f) }`"
              @click="copy(copyCommand(f))"
            >
              <i class="icon icon-copy" /> {{ copied === copyCommand(f) ? 'Copied' : 'Copy command' }}
            </button>
          </td>
        </tr>
      </table>
    </template>
    <div
      v-if="fileError"
      class="text-error vf-file-error"
    >
      {{ fileError }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
.vf { margin: 2px 0 2px 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--border-radius); font-size: 13px; }
.vf-table { width: 100%; td { padding: 2px 16px 2px 0; } }
.vf-path { font-family: monospace; font-size: 12px; word-break: break-all; }
.vf-right { text-align: right; padding-right: 0 !important; }
.vf-file-error { margin-top: 6px; }
.vf-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px;
  select { width: auto; height: 28px; padding: 0 6px; font-size: 12px; }
  .vf-filter input { width: 220px; height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--border-radius); background: var(--input-bg); color: var(--body-text); font-size: 12px; } }
.vf-jump { max-width: 320px; }
.vf-crumbs { flex: 1; font-family: monospace; font-size: 12px; display: flex; gap: 4px; flex-wrap: wrap; word-break: break-all; }
.vf-note { margin: 0 0 6px; }
.vf-folder a { font-weight: 600; }
</style>
