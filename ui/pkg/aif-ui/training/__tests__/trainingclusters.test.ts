import { describe, expect, it, vi } from 'vitest';
import { clusterJobs, hasProfile, httpStatus } from '../trainingclusters';

const rejection = (status: number) => {
  const e: any = new Error(`HTTP ${ status }`);

  Object.defineProperty(e, '_status', { value: status, enumerable: false });

  return e;
};
const storeAnswering = (fn: (url: string) => any) => ({ dispatch: vi.fn(async(_: string, opt: any) => fn(opt.url)) });

describe('reading jobs across clusters', () => {
  it('lists a cluster\'s AIJobs through Rancher\'s proxy for that cluster', async() => {
    const store = storeAnswering((url) => {
      expect(url).toBe('/k8s/clusters/c-m-altra/apis/ai-factory.suse.com/v1alpha1/aijobs');

      return { data: { items: [{ metadata: { name: 'smoke-1' } }] } };
    });

    expect(await clusterJobs(store, 'c-m-altra', 'altra-ai')).toEqual({
      id: 'c-m-altra', name: 'altra-ai', jobs: [{ metadata: { name: 'smoke-1' } }], error: ''
    });
  });

  it('leaves out a cluster without the AIJob API, and says so for one the user cannot read', async() => {
    expect(await clusterJobs(storeAnswering(() => {
      throw rejection(404);
    }), 'c-1', 'edge')).toBeNull();
    expect((await clusterJobs(storeAnswering(() => {
      throw rejection(403);
    }), 'c-2', 'dgx'))?.error).toBe('You cannot list training jobs on this cluster');
  });

  it('checks a profile is on a cluster before offering it there', async() => {
    expect(await hasProfile(storeAnswering(() => ({})), 'c-m-altra', 'gpu-smoke')).toBe(true);
    expect(await hasProfile(storeAnswering(() => {
      throw rejection(404);
    }), 'c-m-altra', 'missing')).toBe(false);
  });

  it('reads the status Steve hides on a rejection', () => {
    expect(httpStatus(rejection(404))).toBe(404);
    expect(httpStatus({ response: { status: 403 } })).toBe(403);
    expect(httpStatus({ code: '500' })).toBe(500);
  });
});
