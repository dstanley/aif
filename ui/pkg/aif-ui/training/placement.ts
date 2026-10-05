// Placing a project on other clusters: the same Rancher project (same id, name and description), the
// same members with the same roles, and its namespaces, on each cluster it spans. Rancher keeps a
// project and its member bindings on the management cluster (a Project in namespace "<cluster>", its
// bindings in "<cluster>-<projectId>"); only the namespaces live on the downstream cluster.
//
// planPlacement works out what a cluster is missing; the panel applies it with the user's own rights.

export const PLACEMENT_ANNOTATION = 'ai-factory.suse.com/clusters';
export const PROJECT_ID_ANNOTATION = 'field.cattle.io/projectId';

export interface ProjectLike {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
  spec?: { displayName?: string; description?: string; clusterName?: string };
}

export interface BindingLike {
  metadata?: { name?: string; namespace?: string };
  projectName?: string;
  roleTemplateName?: string;
  userName?: string;
  userPrincipalName?: string;
  groupName?: string;
  groupPrincipalName?: string;
}

export interface NamespaceLike {
  metadata?: { name?: string; annotations?: Record<string, string> };
}

export interface Binding {
  name: string;
  role: string;
  userName?: string;
  userPrincipalName?: string;
  groupPrincipalName?: string;
}

export interface Plan {
  cluster: string;
  /** the project copy exists already */
  projectExists: boolean;
  /** a project with this id exists there under another name: not ours to take over */
  projectConflict: string;
  addBindings: Binding[];
  createNamespaces: string[];
  /** namespaces there in no project, which the copy takes in */
  adoptNamespaces: string[];
  /** namespaces there in another project: left alone, and reported */
  conflictNamespaces: { name: string; project: string }[];
}

/** The clusters a project is placed on, the cluster it is defined on first. */
export function placedClusters(project: ProjectLike): string[] {
  const home = project?.metadata?.namespace || 'local';
  const more = (project?.metadata?.annotations?.[PLACEMENT_ANNOTATION] || '').split(',').map((c) => c.trim()).filter(Boolean);

  return [home, ...more.filter((c) => c !== home)];
}

/** Who a binding is for, so the same member is recognised on every cluster. */
function subject(b: { userName?: string; userPrincipalName?: string; groupPrincipalName?: string }): string {
  return b.groupPrincipalName ? `group:${ b.groupPrincipalName }` : `user:${ b.userPrincipalName || b.userName || '' }`;
}

/** The project's member bindings, by subject and role. */
export function bindingsOf(projectId: string, all: BindingLike[]): Binding[] {
  return all.filter((b) => b.projectName === projectId && b.roleTemplateName).map((b) => ({
    name:               b.metadata?.name || '',
    role:               b.roleTemplateName || '',
    ...(b.userName ? { userName: b.userName } : {}),
    ...(b.userPrincipalName ? { userPrincipalName: b.userPrincipalName } : {}),
    ...(b.groupPrincipalName ? { groupPrincipalName: b.groupPrincipalName } : {}),
  }));
}

/**
 * What placing the project on a cluster still needs. source is the project as defined; projects and
 * bindings are everything on the management cluster; targetNamespaces are the cluster's namespaces.
 */
export function planPlacement(
  source: ProjectLike, sourceNamespaces: string[], cluster: string,
  projects: ProjectLike[], bindings: BindingLike[], targetNamespaces: NamespaceLike[],
): Plan {
  const id = source.metadata?.name || '';
  const home = source.metadata?.namespace || 'local';
  const copy = projects.find((p) => p.metadata?.namespace === cluster && p.metadata?.name === id);
  const name = source.spec?.displayName || id;
  const conflict = copy && copy.spec?.displayName !== name ? `${ cluster } already has a project ${ id } called "${ copy.spec?.displayName }"` : '';
  const have = new Set(bindingsOf(`${ cluster }:${ id }`, bindings).map((b) => `${ subject(b) }/${ b.role }`));
  const want = bindingsOf(`${ home }:${ id }`, bindings);
  const target = `${ cluster }:${ id }`;
  const plan: Plan = {
    cluster, projectExists: !!copy, projectConflict: conflict, addBindings: [], createNamespaces: [], adoptNamespaces: [], conflictNamespaces: []
  };

  if (conflict) {
    return plan;
  }
  plan.addBindings = want.filter((b) => !have.has(`${ subject(b) }/${ b.role }`));
  for (const ns of sourceNamespaces) {
    const there = targetNamespaces.find((n) => n.metadata?.name === ns);
    const in_ = there?.metadata?.annotations?.[PROJECT_ID_ANNOTATION] || '';

    if (!there) {
      plan.createNamespaces.push(ns);
    } else if (!in_) {
      plan.adoptNamespaces.push(ns);
    } else if (in_ !== target) {
      plan.conflictNamespaces.push({ name: ns, project: in_ });
    }
  }

  return plan;
}

/** Nothing to do: the copy has the project, every member and every namespace. */
export function inStep(p: Plan): boolean {
  return p.projectExists && !p.projectConflict && !p.addBindings.length && !p.createNamespaces.length && !p.adoptNamespaces.length && !p.conflictNamespaces.length;
}

/** One line for a plan: what Apply will do there, or why it cannot. */
export function describePlan(p: Plan): string {
  if (p.projectConflict) {
    return p.projectConflict;
  }
  if (inStep(p)) {
    return 'In step: the project, its members and its namespaces are there';
  }
  const parts: string[] = [];

  if (!p.projectExists) {
    parts.push('create the project');
  }
  if (p.addBindings.length) {
    parts.push(`add ${ p.addBindings.length } member binding${ p.addBindings.length === 1 ? '' : 's' }`);
  }
  if (p.createNamespaces.length) {
    parts.push(`create namespace${ p.createNamespaces.length === 1 ? '' : 's' } ${ p.createNamespaces.join(', ') }`);
  }
  if (p.adoptNamespaces.length) {
    parts.push(`move ${ p.adoptNamespaces.join(', ') } into it`);
  }
  const todo = parts.length ? `Will ${ parts.join(', ') }` : '';
  const conflicts = p.conflictNamespaces.map((c) => `${ c.name } is in project ${ c.project }, left alone`).join('; ');

  return [todo, conflicts].filter(Boolean).join('. ');
}

/** How a cluster schedules a project's runs: its queue there, or the default scheduler. */
export interface ClusterScheduling {
  /** the cluster serves KAI's Queue type */
  kai: boolean;
  /** the cluster serves Kueue's LocalQueue type */
  kueue: boolean;
  /** each of its namespaces' KAI queue label */
  namespaceQueues: Record<string, string>;
  /** queues by name: their parent, for "· parent" */
  queueParents: Record<string, string>;
  /** set when the cluster's facts could not be read */
  error?: string;
}

/** One line for a project's scheduling on a cluster, as Projects & Quotas shows it. */
export function schedulingText(s: ClusterScheduling | undefined, namespaces: string[]): string {
  if (!s) {
    return 'checking…';
  }
  if (s.error) {
    return `not known (${ s.error })`;
  }
  const queues = [...new Set(namespaces.map((n) => s.namespaceQueues[n]).filter(Boolean))];

  if (queues.length) {
    return queues.map((q) => `Queue ${ q }${ s.queueParents[q] ? ` · parent ${ s.queueParents[q] }` : '' }`).join(', ');
  }
  if (s.kai) {
    return 'KAI installed, no queue for this project: default scheduling, no GPU quota';
  }
  if (s.kueue) {
    return 'Kueue installed, no queue for this project: default scheduling, no GPU quota';
  }

  return 'default scheduler (no KAI): no queue, no GPU quota';
}
