import { describe, expect, it } from 'vitest';
import { catalogItems, catalogSections, deployLabel, filterCatalog, tabItems } from '../catalog';

const profile = (over: any) => ({
  name: 'p', type: 'training', displayName: 'P', description: '', framework: 'PyTorch', gpu: 'A2000', status: 'ready', blueprint: null, ...over
} as any);
const blueprint = (over: any) => ({
  family: 'b', displayName: 'B', version: '1.0.0', versions: ['1.0.0'], description: '', category: '', components: 2, source: 'SUSE', ...over
});

describe('catalogItems', () => {
  const profiles = [
    profile({ name: 'lora', displayName: 'LoRA fine-tune' }),
    profile({
      name: 'qwen', type: 'inference', displayName: 'Qwen endpoint', blueprint: { name: 'sie', version: '1.3.0' }
    }),
  ];
  const blueprints = [
    blueprint({ family: 'sie', displayName: 'SUSE Inference Endpoint', category: 'inference' }),
    blueprint({ family: 'rag', displayName: 'NVIDIA RAG' }),
  ];

  it('shows a wrapped blueprint through its profile, which keeps it for the multi-cluster install', () => {
    const items = catalogItems(profiles, blueprints, false);

    expect(items.map((i) => i.title)).toEqual(['LoRA fine-tune', 'Qwen endpoint', 'NVIDIA RAG']);
    expect(items[1].wraps?.family).toBe('sie');
    expect(items[2].kind).toBe('application');
  });

  it('lists wrapped blueprints too when asked, under their category', () => {
    const items = catalogItems(profiles, blueprints, true);

    expect(items.map((i) => i.title)).toEqual(['LoRA fine-tune', 'Qwen endpoint', 'SUSE Inference Endpoint', 'NVIDIA RAG']);
    expect(items[2]).toMatchObject({ kind: 'inference', from: 'blueprint' });
  });

  it('filters by kind, status and text', () => {
    const items = catalogItems(profiles, blueprints, false);

    expect(filterCatalog(items, 'inference', { text: '', status: '' }).map((i) => i.title)).toEqual(['Qwen endpoint']);
    expect(filterCatalog(items, '', { text: 'rag', status: '' }).map((i) => i.title)).toEqual(['NVIDIA RAG']);
    expect(filterCatalog(items, '', { text: '', status: 'beta' })).toEqual([]);
  });

  it('lists apps as applications after the blueprints', () => {
    const items = catalogItems(profiles, blueprints, false, [{
      slug: 'qdrant', name: 'Qdrant', description: 'Vector database', logo: '', library: 'SUSE AI', repositoryName: 'suse-ai', repositoryUrl: ''
    }]);

    expect(items.map((i) => i.title)).toEqual(['LoRA fine-tune', 'Qwen endpoint', 'NVIDIA RAG', 'Qdrant']);
    expect(items[3]).toMatchObject({ kind: 'application', from: 'app', meta: ['App', 'SUSE AI'] });
  });
});

describe('validation profiles', () => {
  it('follow what users deploy, in a section of their own, with their own button', () => {
    const items = catalogItems([
      profile({ name: 'lora', displayName: 'LoRA fine-tune' }),
      profile({ name: 'smoke', displayName: 'GPU Smoke Test', purpose: 'test' }),
      profile({ name: 'nccl', displayName: 'NCCL Fabric Benchmark', purpose: 'benchmark' }),
    ], [], false);

    expect(items.map((i) => i.title)).toEqual(['LoRA fine-tune', 'GPU Smoke Test', 'NCCL Fabric Benchmark']);
    expect(catalogSections(items).map((s) => [s.title, s.items.length, s.collapsible])).toEqual([['Run or deploy', 1, false], ['Validate your environment', 2, true]]);
    expect(items.map(deployLabel)).toEqual(['Run', 'Run test', 'Run benchmark']);
  });
});

describe('tabItems', () => {
  const profiles = [
    profile({ name: 'lora', displayName: 'LoRA fine-tune' }),
    profile({
      name: 'qwen', type: 'inference', displayName: 'Qwen endpoint', blueprint: { name: 'sie', version: '1.3.0' }
    }),
  ];
  const blueprints = [
    blueprint({ family: 'sie', displayName: 'SUSE Inference Endpoint', category: 'inference' }),
    blueprint({ family: 'rag', displayName: 'NVIDIA RAG' }),
  ];
  const items = catalogItems(profiles, blueprints, false);

  it('lists every blueprint in the Blueprints tab, one a profile wraps included, and nothing else', () => {
    const got = tabItems('blueprint', items, blueprints);

    expect(got.map((i) => i.title)).toEqual(['SUSE Inference Endpoint', 'NVIDIA RAG']);
    expect(got.every((i) => i.from === 'blueprint')).toBe(true);
  });

  it('keeps the kind tabs as they are', () => {
    expect(tabItems('', items, blueprints)).toEqual(items);
    expect(tabItems('inference', items, blueprints).map((i) => i.title)).toEqual(['Qwen endpoint']);
    expect(tabItems('application', items, blueprints).map((i) => i.title)).toEqual(['NVIDIA RAG']);
  });
});

describe('a cluster\'s Catalog fits its GPUs', async() => {
  const { fitToCluster, needsGpu } = await import('../catalog');
  const items = catalogItems([
    profile({ name: 'gpu-job', displayName: 'GPU job', form: { gpuMode: 'auto' } }),
    profile({ name: 'cpu-job', displayName: 'CPU job', form: { gpuMode: 'none' } }),
    profile({ name: 'cpu-test', displayName: 'CPU test', purpose: 'test', form: { gpuMode: 'none' } }),
    profile({ name: 'gpu-test', displayName: 'GPU test', purpose: 'test', form: { gpuMode: 'dra' } }),
    profile({ name: 'endpoint', type: 'inference', displayName: 'Endpoint', form: { gpuMode: 'none' } }),
  ], [], false);

  it('knows what needs a GPU', () => {
    expect(items.filter(needsGpu).map((i) => i.title)).toEqual(['GPU job', 'GPU test', 'Endpoint']);
  });

  it('leaves GPU profiles out where there are no GPUs, and counts them', () => {
    const f = fitToCluster(items, 0, false);

    expect(f.items.map((i) => i.title)).toEqual(['CPU job', 'CPU test']);
    expect(f.hidden).toBe(3);
    expect(fitToCluster(items, 0, true).items).toHaveLength(5);
  });

  it('leaves everything in where the GPUs are not known, or there are some', () => {
    expect(fitToCluster(items, null, false)).toEqual({ items, hidden: 0 });
    expect(fitToCluster(items, 2, false).hidden).toBe(0);
  });

  it('offers CPU profiles apart on a cluster with GPUs', () => {
    expect(catalogSections(items, true).map((s) => [s.key, s.items.map((i) => i.title)])).toEqual([
      ['run', ['GPU job', 'Endpoint']], ['validate', ['GPU test']], ['cpu', ['CPU job', 'CPU test']],
    ]);
  });
});
