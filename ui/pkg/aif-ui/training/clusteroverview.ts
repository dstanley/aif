// A cluster's training runs as its AI Training overview lists them: from the AIJob records, which
// outlive the Jobs and pods they describe, the active ones first, then the most recent.

export interface JobRow {
  key: string;
  name: string;
  namespace: string;
  title: string;
  profile: string;
  phase: string;
  color: string; // the badge's background class
  gpus: string;
  nodes: string;
  result: string;
  active: boolean; // pending, queued, admitted or running
  submitted: number; // ms since the epoch, for ordering runs from several clusters together
}

const ACTIVE = new Set(['Pending', 'Queued', 'Admitted', 'Running']);
const COLOR: Record<string, string> = {
  Running: 'bg-success', Succeeded: 'bg-success', Admitted: 'bg-info', Queued: 'bg-info', Pending: 'bg-info', Failed: 'bg-error', Cancelled: 'bg-warning',
};

const phaseOf = (j: any): string => j?.status?.phase || 'Pending';
const submittedOf = (j: any): number => Date.parse(j?.status?.submittedAt || j?.metadata?.creationTimestamp || '') || 0;

/** Active runs first, then the most recent. */
export function byActivity(a: { active: boolean; submitted: number }, b: { active: boolean; submitted: number }): number {
  return Number(b.active) - Number(a.active) || b.submitted - a.submitted;
}

/** How many runs are in each kind of state: running, waiting (queued, admitted or pending), succeeded, failed or cancelled. */
export function jobCounts(jobs: any[]): { running: number; queued: number; succeeded: number; failed: number } {
  const c = {
    running: 0, queued: 0, succeeded: 0, failed: 0
  };

  for (const j of jobs) {
    const p = phaseOf(j);

    if (p === 'Running') {
      c.running++;
    } else if (ACTIVE.has(p)) {
      c.queued++;
    } else if (p === 'Succeeded') {
      c.succeeded++;
    } else {
      c.failed++;
    }
  }

  return c;
}

/** What a run ended with: a test's verdict, else the exit code and reason; '' while it runs. */
function resultOf(j: any): string {
  const s = j?.status || {};

  if (ACTIVE.has(phaseOf(j))) {
    return '';
  }
  if (s.report?.status) {
    const checks = s.report.checks || [];
    const failed = checks.filter((c: any) => !c.ok).length;

    return `${ s.report.status }${ checks.length ? ` (${ checks.length - failed }/${ checks.length } checks)` : '' }`;
  }
  const r = s.result || {};

  return [r.exitCode !== undefined && r.exitCode !== null ? `exit ${ r.exitCode }` : '', r.reason || ''].filter(Boolean).join(' · ');
}

export function jobRows(jobs: any[], limit = 10): JobRow[] {
  const sorted = [...jobs].sort((a, b) => byActivity({ active: ACTIVE.has(phaseOf(a)), submitted: submittedOf(a) }, { active: ACTIVE.has(phaseOf(b)), submitted: submittedOf(b) }));

  return sorted.slice(0, limit).map((j) => {
    const s = j.status || {};
    const nodes = [...new Set((s.pods || []).map((p: any) => p.node).filter(Boolean))] as string[];
    const gpus = s.resources?.gpuCount;
    const product = s.resources?.gpus?.[0]?.product;

    return {
      key:       `${ j.metadata.namespace }/${ j.metadata.name }`,
      name:      j.metadata.name,
      namespace: j.metadata.namespace,
      title:     j.spec?.displayName || j.metadata.name,
      profile:   j.spec?.profile || '',
      phase:     phaseOf(j),
      color:     COLOR[phaseOf(j)] || 'bg-info',
      gpus:      gpus ? `${ gpus }${ product ? ` × ${ product }` : '' }` : '–',
      nodes:     nodes.length ? nodes.map((n) => n.split('.')[0]).join(', ') : '–',
      result:    resultOf(j),
      active:    ACTIVE.has(phaseOf(j)),
      submitted: submittedOf(j),
    };
  });
}
