import { importTypes } from '@rancher/auto-import';
import type { IPlugin } from '@shell/core/types';
import routes from './routing';
import * as productModule from './product';
import * as clusterProductModule from './training/clusterProduct';
import { clusterRoutes } from './training/clusterProduct';
import './style/brand.css';

export default function(plugin: IPlugin): void {
  importTypes(plugin);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  plugin.metadata = require('./package.json');

  // Pass the MODULE so Rancher finds `init`
  plugin.addProduct(productModule as any);

  // Add routes explicitly
  plugin.addRoutes(routes);

  // The per-cluster AI Jobs section, in each cluster that serves the AIJob API
  plugin.addProduct(clusterProductModule as any);
  plugin.addRoutes(clusterRoutes);
}
