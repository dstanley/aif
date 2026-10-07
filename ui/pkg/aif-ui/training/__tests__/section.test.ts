import { describe, expect, it } from 'vitest';
import { CLUSTER_PRODUCT, inClusterSection, trainingLink } from '../section';

const globalRoute = { params: { cluster: 'local' }, meta: { product: 'suseai' } };
const clusterRoute = { params: { cluster: 'c-m-altra' }, meta: { product: CLUSTER_PRODUCT } };

describe('trainingLink', () => {
  it('stays in a cluster\'s AI Jobs section, on that cluster', () => {
    expect(inClusterSection(clusterRoute)).toBe(true);
    expect(trainingLink(clusterRoute, 'jobs')).toEqual({ name: 'c-cluster-aitraining-jobs', params: { cluster: 'c-m-altra' }, query: {} });
    expect(trainingLink(clusterRoute, 'deploy', { profile: 'gpu-smoke' })).toEqual({
      name: 'c-cluster-aitraining-deploy', params: { cluster: 'c-m-altra' }, query: { profile: 'gpu-smoke' }
    });
  });

  it('edits a cluster\'s profiles from its Catalog', () => {
    expect(trainingLink(clusterRoute, 'profiles').name).toBe('c-cluster-aitraining-catalog');
  });

  it('finds the lists on their tabs in the global section', () => {
    expect(inClusterSection(globalRoute)).toBe(false);
    expect(trainingLink(globalRoute, 'jobs')).toEqual({ name: 'c-cluster-suseai-jobs', params: { cluster: 'local' }, query: {} });
    expect(trainingLink(globalRoute, 'profiles', { type: 'inference' })).toEqual({
      name: 'c-cluster-suseai-settings', params: { cluster: 'local' }, query: { tab: 'profiles', type: 'inference' }
    });
    expect(trainingLink(globalRoute, 'catalog', { tab: 'training' }).name).toBe('c-cluster-suseai-catalog');
  });

  it('sends an inference endpoint to the global section, where the operator deploys it', () => {
    expect(trainingLink(clusterRoute, 'endpoint', { profile: 'qwen' })).toEqual({
      name: 'c-cluster-suseai-endpoint', params: { cluster: 'local' }, query: { profile: 'qwen' }
    });
  });
});
