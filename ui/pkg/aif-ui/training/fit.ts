// Whether a cluster can run a profile, and if not, why: what the profile needs (its `requires`, and
// what its values imply) against what the cluster's nodes report (GPU Feature Discovery's labels and
// the nodes' allocatable GPUs). The Catalog shows only what fits, with the reasons for the rest on
// request; the Submit page checks it again before a run starts; the SDK has the same rules
// (rancher_ai/fit.py).
//
// A fact a node does not report (no GPU Feature Discovery, a label missing) is unknown, and an
// unknown never rules a profile out: only what the cluster says it lacks does.

export interface ProfileRequires {
  gpuMemoryGiB?: number; // per GPU, at least
  gpusPerNode?: number; // GPUs on one node, at least
  nodes?: number; // GPU nodes that each meet the above, at least (multi-node runs)
  computeCapability?: string; // at least, "major.minor" (8.0 Ampere, 9.0 Hopper, 10.0 Blackwell)
  driver?: number; // NVIDIA driver major version, at least
  arch?: string[]; // CPU architectures the profile's images exist for (amd64, arm64)
}

const KEYS = ['gpuMemoryGiB', 'gpusPerNode', 'nodes', 'computeCapability', 'driver', 'arch'];

/** A profile's `requires`, with a problem for anything that is not one of its keys or has the wrong type. */
export function parseRequires(raw: any, problems: string[]): ProfileRequires {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('requires must be a mapping');

    return {};
  }
  const out: ProfileRequires = {};

  for (const [k, v] of Object.entries(raw)) {
    if (!KEYS.includes(k)) {
      problems.push(`requires.${ k } is not something a profile can require (${ KEYS.join(', ') })`);
      continue;
    }
    if (k === 'arch') {
      const list = Array.isArray(v) ? v.map(String) : [String(v)];

      out.arch = list.filter(Boolean);
      continue;
    }
    if (k === 'computeCapability') {
      if (!/^\d+(\.\d+)?$/.test(String(v))) {
        problems.push(`requires.computeCapability "${ v }" must be major.minor, e.g. 9.0`);
        continue;
      }
      out.computeCapability = String(v);
      continue;
    }
    const n = Number(v);

    if (!Number.isFinite(n) || n < 0) {
      problems.push(`requires.${ k } must be a number`);
      continue;
    }
    (out as any)[k] = n;
  }

  return out;
}

export interface NodeFacts {
  name: string;
  arch: string; // '' unknown
  gpus: number; // allocatable nvidia.com/gpu
  gpuMemoryMiB: number | null; // per GPU, from nvidia.com/gpu.memory
  computeCapability: [number, number] | null;
  driver: number | null;
  product: string;
}

/** What each node reports about itself, from its labels and allocatable resources. */
export function nodeFacts(nodes: any[]): NodeFacts[] {
  return (nodes || []).map((n: any): NodeFacts => {
    const l = n?.metadata?.labels || {};
    const num = (s: any) => (s === undefined || s === '' || Number.isNaN(Number(s)) ? null : Number(s));
    const major = num(l['nvidia.com/gpu.compute.major']);
    const minor = num(l['nvidia.com/gpu.compute.minor']) ?? 0;

    return {
      name:              n?.metadata?.name || '',
      arch:              l['kubernetes.io/arch'] || '',
      gpus:              parseInt(n?.status?.allocatable?.['nvidia.com/gpu'] || '0', 10) || 0,
      gpuMemoryMiB:      num(l['nvidia.com/gpu.memory']),
      computeCapability: major === null ? null : [major, minor],
      driver:            num(l['nvidia.com/cuda.driver-version.major'] ?? l['nvidia.com/cuda.driver.major']),
      product:           l['nvidia.com/gpu.product'] || '',
    };
  });
}

export interface ProfileNeeds {
  gpu: boolean;
  requires: ProfileRequires;
  shareMiB: number; // a KAI GPU-memory share, 0 for none
  totalGpus: number; // whole GPUs the run needs in all: the fewest workers a user may choose, each with its GPUs
}

/** What a profile needs: its own `requires`, and what its values imply (a GPU at all, a share's size). */
export function needsOf(p: { type?: string; form?: any; requires?: ProfileRequires; limits?: any }): ProfileNeeds {
  const form = p.form || {};
  const gpu = p.type === 'inference' || form.gpuMode !== 'none';
  const shareMiB = Number(form.gpuShareMiB) || 0;
  const r: ProfileRequires = { ...(p.requires || {}) };
  // the fewest GPUs per worker a user may choose: the limit's minimum when the field is open to them
  const perNode = Number(p.limits?.gpusPerNode?.min ?? form.gpusPerNode) || 0;

  if (gpu && perNode > 1 && !shareMiB) {
    r.gpusPerNode = Math.max(r.gpusPerNode || 0, perNode);
  }
  const workers = Number(p.limits?.nodes?.min ?? form.nodes) || 1;

  return {
    gpu, requires: r, shareMiB, totalGpus: gpu && !shareMiB ? workers * Math.max(1, perNode) : 0
  };
}

export interface Fit {
  fits: boolean;
  reasons: string[]; // why not, in words; empty when it fits
}

const ccText = (cc: [number, number]) => `${ cc[0] }.${ cc[1] }`;
const ccOf = (s: string): [number, number] => {
  const [a, b] = s.split('.').map((x) => Number(x) || 0);

  return [a, b || 0];
};
const ccAtLeast = (have: [number, number], want: [number, number]) => have[0] > want[0] || (have[0] === want[0] && have[1] >= want[1]);
const gib = (mib: number) => `${ Math.round(mib / 1024) } GiB`;

/**
 * Whether the cluster's nodes can run a profile. `sharing` says whether GPU-memory shares can be
 * scheduled (KAI is installed); null, unknown.
 */
export function fitOf(needs: ProfileNeeds, facts: NodeFacts[], sharing: boolean | null = null): Fit {
  const r = needs.requires;
  const reasons: string[] = [];

  if (r.arch?.length && facts.length && facts.every((f) => f.arch && !r.arch!.includes(f.arch))) {
    reasons.push(`its images are built for ${ r.arch.join(' or ') }; this cluster's nodes are ${ [...new Set(facts.map((f) => f.arch))].join(', ') }`);
  }
  if (!needs.gpu) {
    return { fits: !reasons.length, reasons };
  }
  const gpuNodes = facts.filter((f) => f.gpus > 0);

  if (!gpuNodes.length) {
    return { fits: false, reasons: [...reasons, 'it needs a GPU, and this cluster has none'] };
  }
  if (needs.shareMiB && sharing === false) {
    reasons.push('it runs on a share of a GPU, which needs KAI GPU sharing, not installed here');
  }
  // the nodes that meet every per-node need (an unknown fact does not rule a node out)
  const wantMiB = Math.max((r.gpuMemoryGiB || 0) * 1024, needs.shareMiB);
  const wantCc = r.computeCapability ? ccOf(r.computeCapability) : null;
  const why = (f: NodeFacts): string[] => {
    const out: string[] = [];

    if (r.gpusPerNode && f.gpus < r.gpusPerNode) {
      out.push(`${ r.gpusPerNode } GPUs on one node`);
    }
    if (wantMiB && f.gpuMemoryMiB !== null && f.gpuMemoryMiB < wantMiB) {
      out.push(`${ gib(wantMiB) } of GPU memory`);
    }
    if (wantCc && f.computeCapability && !ccAtLeast(f.computeCapability, wantCc)) {
      out.push(`compute capability ${ ccText(wantCc) }`);
    }
    if (r.driver && f.driver !== null && f.driver < r.driver) {
      out.push(`NVIDIA driver ${ r.driver } or newer`);
    }
    if (r.arch?.length && f.arch && !r.arch.includes(f.arch)) {
      out.push(r.arch.join(' or '));
    }

    return out;
  };
  const able = gpuNodes.filter((f) => !why(f).length);
  const nodesWanted = r.nodes || 1;
  const total = able.reduce((n, f) => n + f.gpus, 0);

  if (needs.totalGpus > 1 && able.length >= nodesWanted && total < needs.totalGpus) {
    reasons.push(`it needs ${ needs.totalGpus } GPUs in all (one per worker at least); this cluster has ${ total }`);
  }

  if (able.length < nodesWanted) {
    // say what the best node lacks, against what the cluster has
    const best = gpuNodes.map((f) => ({ f, lack: why(f) })).sort((a, b) => a.lack.length - b.lack.length)[0];
    const has = (f: NodeFacts) => [
      f.gpuMemoryMiB !== null ? `${ gib(f.gpuMemoryMiB) } GPUs` : '',
      f.gpus > 1 ? `${ f.gpus } per node` : '',
      f.computeCapability ? `compute capability ${ ccText(f.computeCapability) }` : '',
      f.driver !== null ? `driver ${ f.driver }` : '',
    ].filter(Boolean).join(', ');

    if (best.lack.length) {
      reasons.push(`it needs ${ best.lack.join(', ') }; this cluster's best is ${ has(best.f) || 'unknown' }`);
    }
    if (nodesWanted > 1) {
      reasons.push(`it needs ${ nodesWanted } GPU nodes that meet its needs; this cluster has ${ able.length }`);
    }
  }

  return { fits: !reasons.length, reasons };
}
