// Where a run sits in a workflow, from its AIJob (docs/design/artifacts.md): what submitted it (a
// Kubeflow pipeline run), the chain and step it belongs to, the runs it came after, and the
// artifacts it consumed and produced, each with its content hash and, for an input, the run that
// produced it.

export const CHAIN_LABEL = 'ai-factory.suse.com/chain';
export const STEP_LABEL = 'ai-factory.suse.com/step';
export const PARENTS_ANNOTATION = 'ai-factory.suse.com/parents';
export const INPUTS_ANNOTATION = 'ai-factory.suse.com/inputs';
export const ARTIFACTS_ANNOTATION = 'ai-factory.suse.com/artifacts';
export const ORIGIN_ANNOTATION = 'ai-factory.suse.com/origin';

export interface RunArtifact {
  name: string;
  direction: 'input' | 'output';
  kind: string;
  uri: string;
  sha256: string;
  bytes: number;
  producedBy: string; // for an input: the run that produced it, when the chain knows
}

export interface RunOrigin {
  kind: string; // kubeflow-pipeline
  name: string; // the pipeline
  run: string; // its run
  task: string;
  url: string; // the run in the Pipelines UI; http(s) only, else empty
}

export interface RunWorkflow {
  chain: string;
  step: string;
  parents: string[];
  origin: RunOrigin | null;
  artifacts: RunArtifact[];
}

function json(raw: unknown): any {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// an annotation anyone who may edit the AIJob can set: a link only to a web page
function safeUrl(u: unknown): string {
  const s = String(u || '');

  return /^https?:\/\//i.test(s) ? s : '';
}

/** The run's place in a workflow, or null for a run submitted on its own. */
export function workflowOf(aiJob: any): RunWorkflow | null {
  const md = aiJob?.metadata;

  if (!md) {
    return null;
  }
  const labels = md.labels || {};
  const ann = md.annotations || {};
  const o = json(ann[ORIGIN_ANNOTATION]);
  const origin: RunOrigin | null = o && typeof o === 'object' ? {
    kind: String(o.kind || ''), name: String(o.name || ''), run: String(o.run || o.runId || ''), task: String(o.task || ''), url: safeUrl(o.url)
  } : null;
  const inputs = json(ann[INPUTS_ANNOTATION]) || {};
  const stored = json(ann[ARTIFACTS_ANNOTATION]);
  const artifacts: RunArtifact[] = (Array.isArray(stored) ? stored : []).filter((a: any) => a && a.name && a.uri).map((a: any) => ({
    name:       String(a.name),
    direction:  a.direction === 'input' ? 'input' : 'output',
    kind:       String(a.kind || 'other'),
    uri:        String(a.uri),
    sha256:     String(a.sha256 || ''),
    bytes:      Number(a.bytes) || 0,
    producedBy: a.direction === 'input' ? String(inputs[a.name]?.run || '') : '',
  }));
  const chain = String(labels[CHAIN_LABEL] || '');
  const parents = String(ann[PARENTS_ANNOTATION] || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!chain && !origin && !artifacts.length) {
    return null;
  }

  return {
    chain, step: String(labels[STEP_LABEL] || ''), parents, origin, artifacts
  };
}

/** A URI as a reader takes it in: the volume and path, the model or dataset at a short commit. */
export function shortUri(uri: string): string {
  const v = /^volume:\/\/([^/]+)\/(.*)$/.exec(uri);

  if (v) {
    return `${ v[1] }: ${ v[2] }`;
  }
  const h = /^hf(-dataset)?:\/\/([^@]+)@([0-9a-f]{7,})(\/.*)?$/i.exec(uri);

  if (h) {
    return `${ h[2] } @ ${ h[3].slice(0, 8) }${ h[4] ? ` ${ h[4].slice(1) }` : '' }`;
  }

  return uri.replace(/^hf(-dataset)?:\/\//, '');
}

/** What submitted the run, in words: "Kubeflow pipeline lora-train-evaluate-publish, run lora-2". */
export function originText(o: RunOrigin): string {
  if (o.kind === 'kubeflow-pipeline') {
    return ['Kubeflow pipeline', o.name].filter(Boolean).join(' ');
  }

  return o.kind || 'submitted by a workflow';
}

export interface StepItem {
  name: string; // the run
  step: string; // its step in the chain
  phase: string; // its AIJob phase
  current: boolean;
}

function parentsOf(aiJob: any): string[] {
  return String(aiJob?.metadata?.annotations?.[PARENTS_ANNOTATION] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** The run's path through its chain, for the step strip: the runs it came after (its first parent,
 * and that one's, back to the start), the run itself, and the runs that came after it (the newest
 * that names it as a parent, and so on). A run the chain reused appears where it fed the others. */
export function stepsOf(current: any, chainJobs: any[]): StepItem[] {
  const name = current?.metadata?.name;

  if (!name) {
    return [];
  }
  const byName = new Map<string, any>((chainJobs || []).map((j: any) => [j.metadata?.name, j]));

  byName.set(name, current);
  const item = (j: any): StepItem => ({
    name: j.metadata.name, step: String(j.metadata.labels?.[STEP_LABEL] || ''), phase: String(j.status?.phase || 'Pending'), current: j.metadata.name === name
  });
  const before: StepItem[] = [];
  const seen = new Set([name]);
  let p = parentsOf(current)[0];

  while (p && byName.has(p) && !seen.has(p)) {
    seen.add(p);
    before.unshift(item(byName.get(p)));
    p = parentsOf(byName.get(p))[0];
  }
  const after: StepItem[] = [];
  let at = name;

  for (;;) {
    const next = [...byName.values()]
      .filter((j: any) => !seen.has(j.metadata.name) && parentsOf(j).includes(at))
      .sort((a: any, b: any) => String(b.metadata.creationTimestamp || '').localeCompare(String(a.metadata.creationTimestamp || '')))[0];

    if (!next) {
      break;
    }
    seen.add(next.metadata.name);
    after.push(item(next));
    at = next.metadata.name;
  }

  return [...before, item(current), ...after];
}

export interface RunTiming { started: string; completed: string; seconds: number | null }

/** When the run started and finished, and for how long it ran (status.startedAt / completedAt). */
export function timingOf(aiJob: any): RunTiming | null {
  const st = aiJob?.status || {};
  const started = String(st.startedAt || '');
  const completed = String(st.completedAt || '');

  if (!started && !completed) {
    return null;
  }
  const s = Date.parse(started);
  const e = Date.parse(completed);

  return { started, completed, seconds: Number.isFinite(s) && Number.isFinite(e) && e >= s ? Math.round((e - s) / 1000) : null };
}

/** 43s, 12m 5s, 2h 3m */
export function duration(seconds: number | null): string {
  if (seconds === null) {
    return '—';
  }
  if (seconds < 60) {
    return `${ seconds }s`;
  }
  if (seconds < 3600) {
    return `${ Math.floor(seconds / 60) }m${ seconds % 60 ? ` ${ seconds % 60 }s` : '' }`;
  }

  return `${ Math.floor(seconds / 3600) }h${ Math.floor(seconds % 3600 / 60) ? ` ${ Math.floor(seconds % 3600 / 60) }m` : '' }`;
}
