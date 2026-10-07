// The training pages render in two sections. The global AI Factory section lives on Rancher's
// local cluster; the per-cluster AI Jobs section sits inside each cluster that serves the
// AIJob API, where the GPUs, namespaces and runs are. A link from one training page to another
// stays in the section the user is in: Deploy from a cluster's Catalog goes to that cluster's
// Deploy, and a submitted run lands on that cluster's Jobs.

import { PRODUCT_NAME } from './config';

/** The per-cluster section's product: Rancher's cluster explorer shows it in each cluster's menu. */
export const CLUSTER_PRODUCT = 'aitraining';

/** The per-cluster section's own pages; the form pages (deploy, submit, ...) are shared. */
export const CLUSTER_PAGES = {
  OVERVIEW: 'overview',
  CATALOG:  'catalog',
  JOBS:     'jobs',
  PROJECTS: 'projects',
  PROFILES: 'profiles',
} as const;

/** Where the lists live in the global section: Jobs (every cluster's runs), and tabs of Settings. */
const GLOBAL_PAGES: Record<string, { page: string; query: Record<string, string> }> = {
  jobs:     { page: 'jobs', query: {} },
  projects: { page: 'settings', query: { tab: 'projects' } },
  profiles: { page: 'settings', query: { tab: 'profiles' } },
};

/** In a cluster's section, profiles are edited from its Catalog: each card is one. */
const CLUSTER_ALIASES: Record<string, string> = { profiles: 'catalog' };

/** Pages only the global section has: an inference endpoint is an AIWorkload, which the operator on the local cluster deploys through Fleet. */
const GLOBAL_ONLY = new Set(['endpoint']);

export function inClusterSection(route: any): boolean {
  return route?.meta?.product === CLUSTER_PRODUCT;
}

/**
 * The route to a training page (catalog, jobs, projects, profiles, overview, or a form page such as
 * deploy or submit) in the section the current route is in, on the current route's cluster.
 */
export function trainingLink(route: any, target: string, query: Record<string, any> = {}): any {
  const cluster = route?.params?.cluster;

  if (inClusterSection(route) && !GLOBAL_ONLY.has(target)) {
    return { name: `c-cluster-${ CLUSTER_PRODUCT }-${ CLUSTER_ALIASES[target] || target }`, params: { cluster }, query };
  }
  const g = GLOBAL_PAGES[target] || { page: target, query: {} };

  return {
    name: `c-cluster-${ PRODUCT_NAME }-${ g.page }`, params: { cluster: GLOBAL_ONLY.has(target) ? 'local' : cluster }, query: { ...g.query, ...query }
  };
}
