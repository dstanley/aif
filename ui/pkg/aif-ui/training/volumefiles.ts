// What is on a run's kept checkpoint volume, and a copy of one file, from the browser. A volume can
// only be read from a pod that mounts it, so each request runs a short-lived Job (BCI busybox,
// the volume read-only) and reads its log, the way the SDK's checkpoints ls/get do. A Job rather than a
// bare Pod: AI Job Submitter may create Jobs and read their pods' logs, not create Pods.
import { readPodLog } from './podlog';

// SUSE's BCI busybox: maintained by SUSE, pullable without an account, mirrored like the other BCI images
export const TOOLS_IMAGE = 'registry.suse.com/bci/bci-busybox:15.7';
// a file travels base64-encoded (a third larger) through the log, which the kubelet rotates at 10 MiB
export const MAX_DOWNLOAD_BYTES = 7 * 1024 * 1024;
const MAX_FILES = 500;

export interface VolumeFile {
  path: string; // relative to the volume's root
  size: number; // bytes
  modified: Date | null;
}

/** A shell word for `s`, single-quoted. */
export function shellQuote(s: string): string {
  return `'${ s.replace(/'/g, `'\\''`) }'`;
}

/** Every file on the volume as size|mtime|./path, lost+found skipped, at most MAX_FILES. */
export function listScript(): string {
  return `cd /ckpt && find . -path ./lost+found -prune -o -type f -exec stat -c '%s|%Y|%n' {} + | head -n ${ MAX_FILES }`;
}

// One folder at a time: a volume of any size lists in pages a person can read, one Job per folder
// opened. A folder's subfolders come with how many files they hold and their total size; its files
// with size and date, sorted on the volume and cut at MAX_ENTRIES, with the count before the cut, so a
// listing that is cut says so. A filter searches the folder and everything under it, by file name.
export const MAX_ENTRIES = 500;
export type FolderSort = 'name' | 'size' | 'modified';

export interface VolumeFolder {
  name: string; // within the folder listed
  files: number; // every file under it
  bytes: number;
  modified: Date | null;
}

export interface FolderListing {
  dir: string; // '' for the volume's root
  folders: VolumeFolder[];
  files: VolumeFile[]; // path relative to the volume's root
  totalFiles: number; // before the cut at MAX_ENTRIES
  search: boolean; // a filter's matches from the whole subtree, not the folder's own files
}

/** A folder path within the volume: no leading or trailing slash, and no way out of it. */
export function safeDir(dir: string): string {
  const parts = (dir || '').split('/').filter((p) => p && p !== '.');

  if (parts.includes('..')) {
    throw new Error('A folder path cannot leave the volume');
  }

  return parts.join('/');
}

const SORT_KEYS: Record<FolderSort, string> = {
  name:     "-t'|' -k4",
  size:     "-t'|' -k2,2nr",
  modified: "-t'|' -k3,3nr",
};

/** The listing of one folder (or, with a filter, the files under it whose name contains the filter). */
export function folderScript(dir: string, opts: { sort?: FolderSort; filter?: string } = {}): string {
  const d = safeDir(dir);
  const sort = SORT_KEYS[opts.sort || 'name'];
  const stat = "-exec stat -c 'F|%s|%Y|%n' {} +";
  const cd = `cd ${ shellQuote(d ? `/ckpt/${ d }` : '/ckpt') } 2>/dev/null || { echo NODIR; exit 3; }`;
  const filter = (opts.filter || '').trim();

  if (filter) {
    const match = `-path ./lost+found -prune -o -type f -iname ${ shellQuote(`*${ filter }*`) }`;

    return `${ cd }; echo SEARCH; echo "FILES $(find . ${ match } -print | wc -l)"; ` +
      `find . ${ match } ${ stat } | sort ${ sort } | head -n ${ MAX_ENTRIES }`;
  }

  return `${ cd }; ` +
    "find . -mindepth 1 -maxdepth 1 -type d ! -name lost+found | while IFS= read -r d; do " +
    "s=$(find \"$d\" -type f -exec stat -c %s {} + 2>/dev/null | awk '{s+=$1;n++} END{print n+0\"|\"s+0}'); " +
    "echo \"D|$s|$(stat -c %Y \"$d\")|${d#./}\"; done; " +
    'echo "FILES $(find . -mindepth 1 -maxdepth 1 -type f | wc -l)"; ' +
    `find . -mindepth 1 -maxdepth 1 -type f ${ stat } | sort ${ sort } | head -n ${ MAX_ENTRIES }`;
}

// The whole volume in one Job: every folder (up to INDEX_DIRS) and every file (up to INDEX_FILES),
// with the true counts. When everything fits, the browser lists, sorts and searches every folder
// from it without another Job; when it does not, the folders still give the jump list, and a folder
// is read on its own (folderScript) when opened.
export const INDEX_FILES = 20000;
export const INDEX_DIRS = 5000;

export interface VolumeIndex {
  dirs: string[]; // every folder, as a path from the volume's root, sorted
  files: VolumeFile[];
  totalFiles: number;
  totalDirs: number;
  complete: boolean; // every file and folder is in the index
}

export function indexScript(): string {
  const prune = '-path ./lost+found -prune -o';

  return 'cd /ckpt || exit 3; echo INDEX; ' +
    `echo "FILES $(find . ${ prune } -type f -print | wc -l)"; ` +
    `echo "DIRS $(find . ${ prune } -type d ! -path . -print | wc -l)"; ` +
    `find . ${ prune } -type d ! -path . -print | head -n ${ INDEX_DIRS } | sed 's/^/P|/'; ` +
    `find . ${ prune } -type f -exec stat -c 'F|%s|%Y|%n' {} + | head -n ${ INDEX_FILES }`;
}

export function parseIndex(log: string): VolumeIndex {
  const dirs: string[] = [];
  const files: VolumeFile[] = [];
  let totalFiles = 0;
  let totalDirs = 0;

  for (const raw of (log || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m = line.match(/^P\|\.\/(.+)$/);

    if (m) {
      dirs.push(m[1]);
      continue;
    }
    m = line.match(/^F\|(\d+)\|(\d+)\|\.\/(.+)$/);
    if (m) {
      files.push({ path: m[3], size: Number(m[1]), modified: new Date(Number(m[2]) * 1000) });
      continue;
    }
    m = line.match(/^(FILES|DIRS) (\d+)$/);
    if (m) {
      if (m[1] === 'FILES') {
        totalFiles = Number(m[2]);
      } else {
        totalDirs = Number(m[2]);
      }
    }
  }
  totalFiles = Math.max(totalFiles, files.length);
  totalDirs = Math.max(totalDirs, dirs.length);

  return {
    dirs: dirs.sort(), files, totalFiles, totalDirs, complete: files.length >= totalFiles && dirs.length >= totalDirs
  };
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function sortFiles(files: VolumeFile[], sort: FolderSort): VolumeFile[] {
  const by = sort === 'size' ? (a: VolumeFile, b: VolumeFile) => b.size - a.size :
    sort === 'modified' ? (a: VolumeFile, b: VolumeFile) => (b.modified?.getTime() || 0) - (a.modified?.getTime() || 0) :
      (a: VolumeFile, b: VolumeFile) => a.path.localeCompare(b.path);

  return [...files].sort(by);
}

const TOTALS = new WeakMap<VolumeIndex, Map<string, { files: number; bytes: number; newest: number }>>();

/** Every folder's file count, size and newest file, in one pass over the files (each adds to its ancestors). */
export function folderTotals(index: VolumeIndex): Map<string, { files: number; bytes: number; newest: number }> {
  let out = TOTALS.get(index);

  if (out) {
    return out;
  }
  out = new Map();
  for (const x of index.files) {
    const t = x.modified?.getTime() || 0;

    for (let p = parentOf(x.path); p; p = parentOf(p)) {
      const e = out.get(p) || { files: 0, bytes: 0, newest: 0 };

      e.files++;
      e.bytes += x.size;
      e.newest = Math.max(e.newest, t);
      out.set(p, e);
    }
  }
  TOTALS.set(index, out);

  return out;
}

/** A folder's listing from a complete index: the same shape folderScript's listing has, with no Job. */
export function listFromIndex(index: VolumeIndex, dir: string, sort: FolderSort = 'name', filter = ''): FolderListing {
  const d = safeDir(dir);
  const under = (p: string) => !d || p.startsWith(`${ d }/`);
  const f = filter.trim().toLowerCase();

  if (f) {
    const hits = index.files.filter((x) => under(x.path) && baseOf(x.path).toLowerCase().includes(f));

    return {
      dir: d, folders: [], files: sortFiles(hits, sort).slice(0, MAX_ENTRIES), totalFiles: hits.length, search: true
    };
  }
  const totals = folderTotals(index);
  const folders: VolumeFolder[] = index.dirs.filter((p) => parentOf(p) === d).map((p) => {
    const t = totals.get(p) || { files: 0, bytes: 0, newest: 0 };

    return {
      name: baseOf(p), files: t.files, bytes: t.bytes, modified: t.newest ? new Date(t.newest) : null
    };
  });
  const own = index.files.filter((x) => parentOf(x.path) === d);
  const byFolder = sort === 'size' ? (a: VolumeFolder, b: VolumeFolder) => b.bytes - a.bytes :
    sort === 'modified' ? (a: VolumeFolder, b: VolumeFolder) => (b.modified?.getTime() || 0) - (a.modified?.getTime() || 0) :
      (a: VolumeFolder, b: VolumeFolder) => a.name.localeCompare(b.name);

  return {
    dir: d, folders: folders.sort(byFolder), files: sortFiles(own, sort).slice(0, MAX_ENTRIES), totalFiles: own.length, search: false
  };
}

export class NoFolderError extends Error {}

export function parseFolder(log: string, dir: string, sort: FolderSort = 'name'): FolderListing {
  const d = safeDir(dir);
  const text = log || '';

  if (/^NODIR$/m.test(text)) {
    throw new NoFolderError(`${ d || 'The volume root' } is no longer on the volume.`);
  }
  const folders: VolumeFolder[] = [];
  const files: VolumeFile[] = [];
  let totalFiles = 0;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m = line.match(/^D\|(\d+)\|(\d+)\|(\d+)\|(.+)$/);

    if (m) {
      folders.push({
        name: m[4], files: Number(m[1]), bytes: Number(m[2]), modified: new Date(Number(m[3]) * 1000)
      });
      continue;
    }
    m = line.match(/^F\|(\d+)\|(\d+)\|\.\/(.+)$/);
    if (m) {
      files.push({ path: d ? `${ d }/${ m[3] }` : m[3], size: Number(m[1]), modified: new Date(Number(m[2]) * 1000) });
      continue;
    }
    m = line.match(/^FILES (\d+)$/);
    if (m) {
      totalFiles = Number(m[1]);
    }
  }
  const by = sort === 'size' ? (a: VolumeFolder, b: VolumeFolder) => b.bytes - a.bytes :
    sort === 'modified' ? (a: VolumeFolder, b: VolumeFolder) => (b.modified?.getTime() || 0) - (a.modified?.getTime() || 0) :
      (a: VolumeFolder, b: VolumeFolder) => a.name.localeCompare(b.name);

  return {
    dir: d, folders: folders.sort(by), files, totalFiles: Math.max(totalFiles, files.length), search: /^SEARCH$/m.test(text)
  };
}

// The file travels base64-encoded between these lines. "@" is not in the base64 alphabet, so no line
// of the encoding can be mistaken for them (a bare END can: base64 contains those letters).
export const BEGIN = '@@AIF-BEGIN@@';
export const END = '@@AIF-END@@';

/** One file, base64 between BEGIN and END; NOFILE or TOOBIG (with its SIZE) instead when it cannot be. */
export function fileScript(path: string): string {
  const src = shellQuote(`/ckpt/${ path.replace(/^\/+/, '') }`);

  return `test -f ${ src } || { echo NOFILE; exit 3; }; n=$(wc -c < ${ src }); echo SIZE $n; ` +
    `[ $n -le ${ MAX_DOWNLOAD_BYTES } ] || { echo TOOBIG; exit 4; }; echo ${ BEGIN }; base64 ${ src }; echo ${ END }`;
}

export function parseListing(log: string): VolumeFile[] {
  const out: VolumeFile[] = [];

  for (const line of (log || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\|(\d+)\|\.\/(.+)$/);

    if (m) {
      out.push({ path: m[3], size: Number(m[1]), modified: new Date(Number(m[2]) * 1000) });
    }
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export type Decoded = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'missing' | 'too-big' | 'incomplete'; size?: number };

export function decodeFile(log: string): Decoded {
  const text = log || '';

  if (/^NOFILE$/m.test(text)) {
    return { ok: false, reason: 'missing' };
  }
  if (/^TOOBIG$/m.test(text)) {
    const size = Number((text.match(/^SIZE (\d+)$/m) || [])[1]);

    return { ok: false, reason: 'too-big', size: Number.isFinite(size) ? size : undefined };
  }
  const lines = text.split('\n').map((l) => l.trim());
  const at = lines.indexOf(BEGIN);
  const end = at >= 0 ? lines.indexOf(END, at + 1) : -1;

  if (at < 0 || end < 0) {
    return { ok: false, reason: 'incomplete' };
  }
  const bin = atob(lines.slice(at + 1, end).join(''));
  const bytes = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }

  return { ok: true, bytes };
}

export function jobManifest(namespace: string, claim: string, name: string, script: string): any {
  const labels = { 'app.kubernetes.io/managed-by': 'aif-ui', 'aif-ui/volume-files': claim.slice(0, 63) };

  return {
    apiVersion: 'batch/v1',
    kind:       'Job',
    metadata:   { name, namespace, labels },
    spec:       {
      backoffLimit:            0,
      ttlSecondsAfterFinished: 300,
      template:                {
        metadata: { labels },
        spec:     {
          restartPolicy: 'Never',
          containers:    [{
            name:         'files',
            image:        TOOLS_IMAGE,
            command:      ['sh', '-c', script],
            volumeMounts: [{ name: 'ckpt', mountPath: '/ckpt', readOnly: true }],
            resources:    { requests: { cpu: '20m', memory: '16Mi' }, limits: { memory: '64Mi' } },
          }],
          volumes: [{ name: 'ckpt', persistentVolumeClaim: { claimName: claim, readOnly: true } }],
        },
      },
    },
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${ n } B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;

  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }

  return `${ v < 10 ? v.toFixed(1) : Math.round(v) } ${ units[i] }`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `script` against the volume in a one-pod Job and return its log. The Job is deleted
 * afterwards (its pods with it); its ttl cleans up after a closed tab.
 */
export async function runVolumeJob(store: any, cluster: string, namespace: string, claim: string, script: string, timeoutMs = 120000): Promise<string> {
  const base = `/k8s/clusters/${ encodeURIComponent(cluster) }`;
  const ns = encodeURIComponent(namespace);
  const name = `ckpt-files-${ Math.random().toString(36).slice(2, 7) }`;
  const req = (opt: any) => store.dispatch('cluster/request', opt);
  // writes go through rancher/request with an explicit JSON body, as the extension's other creates
  // through this proxy do
  const write = (opt: any) => store.dispatch('rancher/request', { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });

  await write({
    url: `${ base }/apis/batch/v1/namespaces/${ ns }/jobs`, method: 'POST', data: jobManifest(namespace, claim, name, script)
  });
  try {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const job = await req({ url: `${ base }/apis/batch/v1/namespaces/${ ns }/jobs/${ name }` });
      const st = job?.status || job?.data?.status || {};

      if (st.succeeded || st.failed) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`reading ${ claim } took longer than ${ Math.round(timeoutMs / 1000) }s (Job ${ name })`);
      }
      await sleep(2000);
    }
    const pods = await req({ url: `${ base }/api/v1/namespaces/${ ns }/pods?labelSelector=${ encodeURIComponent(`job-name=${ name }`) }` });
    const pod = (pods?.items || pods?.data?.items || [])[0];

    if (!pod) {
      throw new Error(`the Job ${ name } finished without a pod`);
    }
    return await readPodLog(store, cluster, namespace, pod.metadata.name);
  } finally {
    write({ url: `${ base }/apis/batch/v1/namespaces/${ ns }/jobs/${ name }?propagationPolicy=Background`, method: 'DELETE' }).catch(() => undefined);
  }
}
