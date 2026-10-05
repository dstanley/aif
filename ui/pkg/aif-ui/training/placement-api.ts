// Applying a placement plan with the user's own Rancher rights: the project and its member bindings on
// the management cluster, the namespaces on the downstream cluster through Rancher's cluster proxy.
import {
  Plan, PLACEMENT_ANNOTATION, PROJECT_ID_ANNOTATION, ProjectLike
} from './placement';

/** On every copy: which project it was copied from. */
export const SOURCE_LABEL = 'ai-factory.suse.com/project-source';

type Request = (opt: { url: string; method?: string; data?: any }) => Promise<any>;

const status = (e: any): number => Number(e?._status || e?.status || e?.response?.status || 0);

async function createOrKeep(req: Request, url: string, data: any): Promise<'created' | 'existed'> {
  try {
    await req({ url, method: 'POST', data });

    return 'created';
  } catch (e: any) {
    if (status(e) === 409) {
      return 'existed';
    }
    throw e;
  }
}

/** The namespaces of a downstream cluster, through Rancher. */
export async function clusterNamespaces(req: Request, cluster: string): Promise<any[]> {
  const res = await req({ url: `/k8s/clusters/${ encodeURIComponent(cluster) }/v1/namespaces?limit=-1` });

  return res?.data || [];
}

/**
 * Apply one cluster's plan; returns what was done, line by line. Rancher creates a project's backing
 * namespace ("<cluster>-<project>") on the management cluster, where its bindings go, so a new
 * project is waited for before its members are added.
 */
export async function applyPlan(req: Request, source: ProjectLike, plan: Plan, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  nameOf: (cluster: string) => string = (c) => c,
  memberOf: (b: Plan['addBindings'][number]) => string = (b) => `${ b.groupPrincipalName || b.userName || b.userPrincipalName } (${ b.role })`): Promise<string[]> {
  const id = source.metadata?.name || '';
  const home = source.metadata?.namespace || 'local';
  const c = plan.cluster;
  const shown = nameOf(c);
  const labels = { [SOURCE_LABEL]: `${ home }.${ id }` };
  const done: string[] = [];

  if (plan.projectConflict) {
    return [`${ shown }: skipped, ${ plan.projectConflict }`];
  }
  if (!plan.projectExists) {
    await createOrKeep(req, '/v1/management.cattle.io.projects', {
      type:     'management.cattle.io.project',
      metadata: { name: id, namespace: c, labels },
      spec:     { clusterName: c, displayName: source.spec?.displayName || id, description: source.spec?.description || '' },
    });
    done.push(`${ shown }: created project ${ source.spec?.displayName || id }`);
  }
  if (plan.addBindings.length) {
    const backing = `${ c }-${ id }`;

    for (let i = 0; i < 30; i++) {
      try {
        await req({ url: `/v1/namespaces/${ backing }` });
        break;
      } catch (e: any) {
        if (status(e) !== 404 || i === 29) {
          throw new Error(`${ shown }: the project's namespace ${ backing } did not appear: ${ e?.message || e }`);
        }
        await sleep(1000);
      }
    }
    for (const b of plan.addBindings) {
      await createOrKeep(req, '/v1/management.cattle.io.projectroletemplatebindings', {
        type:             'management.cattle.io.projectroletemplatebinding',
        metadata:         { name: b.name, namespace: backing, labels },
        projectName:      `${ c }:${ id }`,
        roleTemplateName: b.role,
        ...(b.userName ? { userName: b.userName } : {}),
        ...(b.userPrincipalName ? { userPrincipalName: b.userPrincipalName } : {}),
        ...(b.groupPrincipalName ? { groupPrincipalName: b.groupPrincipalName } : {}),
      });
    }
    done.push(`${ shown }: added ${ plan.addBindings.map(memberOf).join(', ') }`);
  }
  const nsUrl = `/k8s/clusters/${ encodeURIComponent(c) }/v1/namespaces`;

  for (const ns of plan.createNamespaces) {
    await createOrKeep(req, nsUrl, { type: 'namespace', metadata: { name: ns, annotations: { [PROJECT_ID_ANNOTATION]: `${ c }:${ id }` } } });
    done.push(`${ shown }: created namespace ${ ns }`);
  }
  for (const ns of plan.adoptNamespaces) {
    const obj = await req({ url: `${ nsUrl }/${ ns }` });

    obj.metadata.annotations = { ...(obj.metadata.annotations || {}), [PROJECT_ID_ANNOTATION]: `${ c }:${ id }` };
    await req({ url: `${ nsUrl }/${ ns }`, method: 'PUT', data: obj });
    done.push(`${ shown }: moved namespace ${ ns } into the project`);
  }
  plan.conflictNamespaces.forEach((n) => done.push(`${ shown }: left ${ n.name } alone (it is in project ${ n.project })`));

  return done;
}

/** Record the clusters a project is placed on (its own cluster is implied). */
export async function savePlacement(req: Request, source: ProjectLike, clusters: string[]): Promise<void> {
  const id = source.metadata?.name || '';
  const home = source.metadata?.namespace || 'local';
  const url = `/v1/management.cattle.io.projects/${ home }/${ id }`;
  const obj = await req({ url });
  const others = clusters.filter((c) => c !== home);
  const annotations = { ...(obj.metadata?.annotations || {}) };

  if (others.length) {
    annotations[PLACEMENT_ANNOTATION] = others.join(',');
  } else {
    delete annotations[PLACEMENT_ANNOTATION];
  }
  obj.metadata.annotations = annotations;
  await req({ url, method: 'PUT', data: obj });
}
