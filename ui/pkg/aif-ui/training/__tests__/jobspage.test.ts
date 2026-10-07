import { describe, expect, it, vi } from 'vitest';
import stevePaginationUtils from '@shell/plugins/steve/steve-pagination-utils';
import {
  fetchJobsPage, fetchRelated, jobsPagination, JobsQuery, namespacesPagination, pageLocally, relatedPagination
} from '../jobspage';

const Q: JobsQuery = {
  page: 1, pageSize: 25, sortKey: 'created', sortDesc: true, text: '', namespace: '', profile: '', state: ''
};

// the query string Rancher's store sends for these arguments
const params = (pagination: any) => decodeURIComponent(stevePaginationUtils.createParamsForPagination({ opt: { pagination } as any }) || '');

describe('jobsPagination', () => {
  it('asks for one page, newest first', () => {
    expect(params(jobsPagination(Q))).toBe('page=1&pagesize=25&sort=-metadata.creationTimestamp');
  });

  it('filters on the server: part of the name, the namespace, the profile and phase labels', () => {
    const p = params(jobsPagination({
      ...Q, page: 3, text: ' lora ', namespace: 'aif-submit', profile: 'shared-gpu-dev', state: 'Pending'
    }));

    expect(p).toContain('page=3&pagesize=25');
    expect(p).toContain('filter=metadata.name~lora');
    expect(p).toContain('filter=metadata.namespace="aif-submit"');
    expect(p).toContain('filter=metadata.labels[ai-factory.suse.com/profile]="shared-gpu-dev"');
    // Pending covers Admitted too
    expect(p).toContain('filter=metadata.labels[ai-factory.suse.com/phase] IN (Pending,Admitted)');
  });

  it('sorts by a column the server can sort, then newest first within equal values', () => {
    expect(params(jobsPagination({ ...Q, sortKey: 'name', sortDesc: false }))).toContain('sort=metadata.name,-metadata.creationTimestamp');
    expect(params(jobsPagination({ ...Q, sortKey: 'state', sortDesc: true }))).toContain('sort=-metadata.labels[ai-factory.suse.com/phase]');
  });

  it('falls back to newest first for a column the server cannot sort', () => {
    expect(params(jobsPagination({ ...Q, sortKey: 'resources' }))).toContain('sort=-metadata.creationTimestamp');
  });
});

describe('the objects of a page of runs', () => {
  it('come by their job-id label, all runs in one request', () => {
    expect(params(relatedPagination(['dev-a', 'dev-b']))).toContain('filter=metadata.labels[ai-factory.suse.com/job-id] IN (dev-a,dev-b)');
  });

  it('claim templates come by namespace, any of them', () => {
    expect(params(namespacesPagination(['a', 'b']))).toContain('filter=metadata.namespace IN (a,b)');
  });

  it('are not fetched for an empty page', async() => {
    const store = { getters: { 'cluster/schemaFor': () => true }, dispatch: vi.fn() };

    expect((await fetchRelated(store, [])).pods).toEqual([]);
    expect(store.dispatch).not.toHaveBeenCalled();
  });
});

const job = (name: string, created: string, phase = 'Succeeded', extra: any = {}) => ({
  metadata: { name, namespace: extra.ns || 'aif-submit', creationTimestamp: created }, spec: { profile: extra.profile || '' }, status: { phase }
});

describe('pageLocally (no SQL cache)', () => {
  const all = [job('dev-a', '2026-10-01'), job('dev-b', '2026-10-03', 'Running'), job('eval-c', '2026-10-02', 'Failed', { ns: 'other' })];

  it('applies the same filters and order as the server', () => {
    expect(pageLocally(all, Q).aiJobs.map((j) => j.metadata.name)).toEqual(['dev-b', 'eval-c', 'dev-a']);
    expect(pageLocally(all, { ...Q, text: 'DEV' }).count).toBe(2);
    expect(pageLocally(all, { ...Q, state: 'Failed' }).aiJobs.map((j) => j.metadata.name)).toEqual(['eval-c']);
    expect(pageLocally(all, { ...Q, namespace: 'other' }).count).toBe(1);
  });

  it('cuts the requested page', () => {
    const r = pageLocally(all, { ...Q, page: 2, pageSize: 2 });

    expect(r.count).toBe(3);
    expect(r.aiJobs.map((j) => j.metadata.name)).toEqual(['dev-a']);
  });
});

describe('fetchJobsPage', () => {
  it('uses the server page when the server can page', async() => {
    const dispatch = vi.fn(async(action: string) => (action === 'cluster/findPage' ? { data: [job('dev-a', '2026-10-01')], pagination: { result: { count: 812 } } } : []));
    const r = await fetchJobsPage({ dispatch }, Q);

    expect(r).toMatchObject({ count: 812, serverPaged: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('lists once and pages in the browser when the server cannot page', async() => {
    const dispatch = vi.fn(async(action: string) => {
      if (action === 'cluster/findPage') {
        throw { status: 404 };
      }

      return [job('dev-a', '2026-10-01'), job('dev-b', '2026-10-02')];
    });
    const r = await fetchJobsPage({ dispatch }, { ...Q, pageSize: 1 });

    expect(r).toMatchObject({ count: 2, serverPaged: false });
    expect(r.aiJobs.map((j: any) => j.metadata.name)).toEqual(['dev-b']);
  });

  it('reports a request the server refused rather than hiding it', async() => {
    const dispatch = vi.fn(async() => {
      throw { status: 422, message: 'column is invalid' };
    });

    await expect(fetchJobsPage({ dispatch }, Q)).rejects.toMatchObject({ status: 422 });
  });
});
