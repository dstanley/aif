import {
  PRODUCT_NAME, INFERENCE_PROFILE_PAGE, SUBMIT_PAGE, JOBS_PAGE, PROJECTS_PAGE, PROFILES_PAGE, DEPLOY_PAGE, ENDPOINT_PAGE, ENDPOINTS_PAGE
} from './config';

const page = (name: string, component: () => Promise<any>) => ({
  name:      `c-cluster-${ PRODUCT_NAME }-${ name }`,
  path:      `/c/:cluster/${ PRODUCT_NAME }/${ name }`,
  component,
  meta:      { product: PRODUCT_NAME },
});

export const trainingRoutes = [
  // Projects & Quotas is a tab of Settings: an administrator's page, not a daily one
  {
    name:     `c-cluster-${ PRODUCT_NAME }-${ PROJECTS_PAGE }`,
    path:     `/c/:cluster/${ PRODUCT_NAME }/${ PROJECTS_PAGE }`,
    redirect: (to: any) => ({ name: `c-cluster-${ PRODUCT_NAME }-settings`, params: to.params, query: { tab: 'projects' } }),
    meta:     { product: PRODUCT_NAME },
  },
  // Profiles are created and edited from each cluster's AI Jobs > Catalog, by those allowed to
  {
    name:     `c-cluster-${ PRODUCT_NAME }-${ PROFILES_PAGE }`,
    path:     `/c/:cluster/${ PRODUCT_NAME }/${ PROFILES_PAGE }`,
    redirect: (to: any) => ({ name: `c-cluster-${ PRODUCT_NAME }-settings`, params: to.params, query: { ...to.query, tab: 'profiles' } }),
    meta:     { product: PRODUCT_NAME },
  },
  page(INFERENCE_PROFILE_PAGE, () => import('./pages/InferenceProfile.vue')),
  page(DEPLOY_PAGE, () => import('./pages/Deploy.vue')),
  page(ENDPOINT_PAGE, () => import('./pages/DeployEndpoint.vue')),
  page(SUBMIT_PAGE, () => import('./pages/Submit.vue')),
  // Jobs: training and test runs on every cluster
  page(JOBS_PAGE, () => import('./pages/AllJobs.vue')),
  // The old list page: its training runs are on Jobs now, its inference endpoints on Workloads.
  {
    name:     `c-cluster-${ PRODUCT_NAME }-${ ENDPOINTS_PAGE }`,
    path:     `/c/:cluster/${ PRODUCT_NAME }/${ ENDPOINTS_PAGE }`,
    redirect: (to: any) => (to.query.tab === 'inference' ? { name: `c-cluster-${ PRODUCT_NAME }-workloads`, params: to.params } : { name: `c-cluster-${ PRODUCT_NAME }-${ JOBS_PAGE }`, params: to.params }),
    meta:     { product: PRODUCT_NAME },
  },
];
