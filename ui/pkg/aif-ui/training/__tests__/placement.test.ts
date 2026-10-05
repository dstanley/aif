import { describe, expect, it } from 'vitest';
import {
  bindingsOf, describePlan, inStep, PLACEMENT_ANNOTATION, placedClusters, planPlacement
} from '../placement';

const project = (cluster: string, name = 'Training Teams', annotations: Record<string, string> = {}) => ({
  metadata: { name: 'p-training', namespace: cluster, annotations }, spec: { displayName: name, description: 'Namespaces where users submit training jobs' }
});
const binding = (cluster: string, role: string, user = 'm-86h52') => ({
  metadata: { name: `${ user }-${ role }`, namespace: `${ cluster }-p-training` }, projectName: `${ cluster }:p-training`, roleTemplateName: role, userName: user, userPrincipalName: `local://${ user }`
});
const ns = (name: string, project?: string) => ({ metadata: { name, annotations: (project ? { 'field.cattle.io/projectId': project } : {}) as Record<string, string> } });

const source = project('local');
const homeBindings = [binding('local', 'ai-job-submitter'), binding('local', 'training-job-submitter')];

describe('placing a project on another cluster', () => {
  it('plans everything for a cluster that has none of it', () => {
    const p = planPlacement(source, ['aif-submit'], 'c-npk9v', [source], homeBindings, []);

    expect(p).toMatchObject({ projectExists: false, createNamespaces: ['aif-submit'], adoptNamespaces: [], conflictNamespaces: [] });
    expect(p.addBindings.map((b) => b.role)).toEqual(['ai-job-submitter', 'training-job-submitter']);
    expect(describePlan(p)).toBe('Will create the project, add 2 member bindings, create namespace aif-submit');
  });

  it('is in step when the copy has the project, every member and the namespace', () => {
    const p = planPlacement(source, ['aif-submit'], 'c-npk9v', [source, project('c-npk9v')],
      [...homeBindings, binding('c-npk9v', 'ai-job-submitter'), binding('c-npk9v', 'training-job-submitter')], [ns('aif-submit', 'c-npk9v:p-training')]);

    expect(inStep(p)).toBe(true);
  });

  it('adds only the member who is missing, matched by who and role', () => {
    const p = planPlacement(source, ['aif-submit'], 'c-npk9v', [source, project('c-npk9v')],
      [...homeBindings, binding('c-npk9v', 'ai-job-submitter')], [ns('aif-submit', 'c-npk9v:p-training')]);

    expect(p.addBindings.map((b) => b.role)).toEqual(['training-job-submitter']);
  });

  it('takes in a namespace in no project, and leaves one in another project alone', () => {
    const p = planPlacement(source, ['aif-submit', 'shared'], 'c-npk9v', [source, project('c-npk9v')], homeBindings,
      [ns('aif-submit'), ns('shared', 'c-npk9v:p-other')]);

    expect(p.adoptNamespaces).toEqual(['aif-submit']);
    expect(p.conflictNamespaces).toEqual([{ name: 'shared', project: 'c-npk9v:p-other' }]);
    expect(describePlan(p)).toContain('shared is in project c-npk9v:p-other, left alone');
  });

  it('does not take over a project with the same id but another name', () => {
    const p = planPlacement(source, ['aif-submit'], 'c-npk9v', [source, project('c-npk9v', 'Someone else')], homeBindings, []);

    expect(p.projectConflict).toContain('called "Someone else"');
    expect(p.addBindings).toEqual([]);
    expect(p.createNamespaces).toEqual([]);
  });

  it('reads the placement from the project, its own cluster first', () => {
    expect(placedClusters(project('local', 'T', { [PLACEMENT_ANNOTATION]: 'c-npk9v, c-djjjc' }))).toEqual(['local', 'c-npk9v', 'c-djjjc']);
    expect(placedClusters(project('local'))).toEqual(['local']);
  });

  it('keeps group members as groups', () => {
    const g = { ...binding('local', 'project-member'), userName: undefined, userPrincipalName: undefined, groupPrincipalName: 'keycloakoidc_group://developers' };

    expect(bindingsOf('local:p-training', [g as any])).toEqual([{ name: 'm-86h52-project-member', role: 'project-member', groupPrincipalName: 'keycloakoidc_group://developers' }]);
  });
});

describe('applying a placement', async () => {
  const { applyPlan, savePlacement, SOURCE_LABEL } = await import('../placement-api');
  const fakeRancher = (opts: { backingAfter?: number; exists?: string[] } = {}) => {
    const calls: { method: string; url: string; data?: any }[] = [];
    let waits = 0;
    const req = async({ url, method = 'GET', data }: any) => {
      calls.push({ method, url, data });
      if (method === 'GET' && url.startsWith('/v1/namespaces/')) {
        if (waits++ < (opts.backingAfter || 0)) {
          throw Object.assign(new Error('not found'), { _status: 404 });
        }

        return {};
      }
      if (method === 'POST' && (opts.exists || []).some((u) => data?.metadata?.name === u)) {
        throw Object.assign(new Error('exists'), { _status: 409 });
      }
      if (method === 'GET' && url.includes('/management.cattle.io.projects/')) {
        return { metadata: { name: 'p-training', annotations: { other: 'x' } } };
      }

      return {};
    };

    return { calls, req };
  };

  it('creates the project, waits for its namespace, adds the members, then the namespaces', async() => {
    const { calls, req } = fakeRancher({ backingAfter: 2 });
    const plan = planPlacement(source, ['aif-submit'], 'c-npk9v', [source], homeBindings, []);
    const log = await applyPlan(req, source, plan, async() => {});

    const posts = calls.filter((c) => c.method === 'POST');

    expect(posts.map((c) => c.url)).toEqual([
      '/v1/management.cattle.io.projects',
      '/v1/management.cattle.io.projectroletemplatebindings', '/v1/management.cattle.io.projectroletemplatebindings',
      '/k8s/clusters/c-npk9v/v1/namespaces',
    ]);
    expect(posts[0].data).toMatchObject({ metadata: { name: 'p-training', namespace: 'c-npk9v', labels: { [SOURCE_LABEL]: 'local.p-training' } }, spec: { displayName: 'Training Teams' } });
    expect(posts[1].data).toMatchObject({ metadata: { namespace: 'c-npk9v-p-training' }, projectName: 'c-npk9v:p-training', roleTemplateName: 'ai-job-submitter', userName: 'm-86h52' });
    expect(posts[3].data.metadata.annotations).toEqual({ 'field.cattle.io/projectId': 'c-npk9v:p-training' });
    expect(calls.filter((c) => c.url === '/v1/namespaces/c-npk9v-p-training')).toHaveLength(3);
    expect(log).toEqual(['c-npk9v: created project Training Teams', 'c-npk9v: added m-86h52 (ai-job-submitter), m-86h52 (training-job-submitter)', 'c-npk9v: created namespace aif-submit']);
  });

  it('treats something that exists already as done', async() => {
    const { req } = fakeRancher({ exists: ['p-training', 'aif-submit'] });
    const plan = planPlacement(source, ['aif-submit'], 'c-npk9v', [source], homeBindings, []);

    await expect(applyPlan(req, source, plan, async() => {})).resolves.toHaveLength(3);
  });

  it('records the placement on the project, keeping its other annotations', async() => {
    const { calls, req } = fakeRancher();

    await savePlacement(req, source, ['local', 'c-npk9v', 'c-djjjc']);
    const put = calls.find((c) => c.method === 'PUT');

    expect(put?.url).toBe('/v1/management.cattle.io.projects/local/p-training');
    expect(put?.data.metadata.annotations).toEqual({ other: 'x', [PLACEMENT_ANNOTATION]: 'c-npk9v,c-djjjc' });
  });
});
