// The per-cluster AI Training section: in each cluster that serves the AIJob API, its own menu with
// that cluster's overview, training catalog (whose cards an administrator edits: each is a compute
// profile), jobs, and projects and quotas. Apps and blueprints are deployed centrally, from AI
// Factory's Apps, Blueprints and Workloads, to any cluster through Fleet. The
// pages are the same components the global AI Factory section uses; they read the cluster from the
// route, and links between them stay in this section (see section.ts).
import { CLUSTER_PRODUCT, CLUSTER_PAGES } from './section';
import { DEPLOY_PAGE, INFERENCE_PROFILE_PAGE, SUBMIT_PAGE } from './config';
import { AIJOB_TYPE } from './aijob';

const routeName = (page: string) => `c-cluster-${ CLUSTER_PRODUCT }-${ page }`;
const page = (name: string, component: () => Promise<any>) => ({
  name:      routeName(name),
  path:      `/c/:cluster/${ CLUSTER_PRODUCT }/${ name }`,
  component,
  meta:      { product: CLUSTER_PRODUCT },
});

export const clusterRoutes = [
  page(CLUSTER_PAGES.OVERVIEW, () => import('./pages/ClusterOverview.vue')),
  page(CLUSTER_PAGES.CATALOG, () => import('../pages/Catalog.vue')),
  page(CLUSTER_PAGES.JOBS, () => import('./pages/Workloads.vue')),
  page(CLUSTER_PAGES.PROJECTS, () => import('./pages/Projects.vue')),
  page(DEPLOY_PAGE, () => import('./pages/Deploy.vue')),
  page(SUBMIT_PAGE, () => import('./pages/Submit.vue')),
  page(INFERENCE_PROFILE_PAGE, () => import('./pages/InferenceProfile.vue')),
];

// Menu order is by weight, descending.
const NAV: { name: string; weight: number }[] = [
  { name: CLUSTER_PAGES.OVERVIEW, weight: 500 },
  { name: CLUSTER_PAGES.CATALOG, weight: 400 },
  { name: CLUSTER_PAGES.JOBS, weight: 300 },
  { name: CLUSTER_PAGES.PROJECTS, weight: 200 },
];

export function init($plugin: any, store: any) {
  const { product, virtualType, basicType } = $plugin.DSL(store, CLUSTER_PRODUCT);

  product({
    icon:       'ai',
    inStore:    'cluster',
    weight:     90,
    // only where the AIJob API is served and the user can see it
    ifHaveType: AIJOB_TYPE,
    to:         { name: routeName(CLUSTER_PAGES.OVERVIEW), params: { product: CLUSTER_PRODUCT } },
  });

  for (const n of NAV) {
    virtualType({
      labelKey: `${ CLUSTER_PRODUCT }.nav.${ n.name }`,
      name:     n.name,
      weight:   n.weight,
      route:    { name: routeName(n.name), params: { product: CLUSTER_PRODUCT } },
    });
  }
  basicType(NAV.map((n) => n.name));
}
