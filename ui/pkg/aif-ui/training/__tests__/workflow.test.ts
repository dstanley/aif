import { describe, expect, it } from 'vitest';
import { originText, shortUri, workflowOf } from '../workflow';

const evalJob = {
  metadata: {
    name:   'dev-lora-pipeline-eval-n9ovg',
    labels: { 'ai-factory.suse.com/chain': 'lora-pipeline', 'ai-factory.suse.com/step': 'eval' },
    annotations: {
      'ai-factory.suse.com/parents': 'dev-lora-pipeline-train-eouku',
      'ai-factory.suse.com/origin':  JSON.stringify({
        kind: 'kubeflow-pipeline', name: 'lora-train-evaluate-publish', run: 'lora-2', runId: '732b10b3', task: 'evaluate', url: 'http://127.0.0.1:18399/#/runs/details/732b10b3'
      }),
      'ai-factory.suse.com/inputs': JSON.stringify({ adapter: { name: 'adapter', uri: 'volume://t-checkpoints/t/adapter', run: 'dev-lora-pipeline-train-eouku' } }),
      'ai-factory.suse.com/artifacts': JSON.stringify([
        {
          name: 'adapter', direction: 'input', kind: 'model', uri: 'volume://t-checkpoints/t/adapter', sha256: '33175b6accf6aa'
        },
        { name: 'base-model', direction: 'input', kind: 'model', uri: 'hf://Qwen/Qwen2.5-0.5B-Instruct' },
        {
          name: 'eval', direction: 'output', kind: 'metrics', uri: 'volume://e-checkpoints/e/eval.json', sha256: 'ff8e5030'
        },
      ]),
    },
  },
};

describe('workflowOf', () => {
  it('says what submitted the run, its chain and step, and what it used and produced', () => {
    const w = workflowOf(evalJob);

    expect(w).toMatchObject({ chain: 'lora-pipeline', step: 'eval', parents: ['dev-lora-pipeline-train-eouku'] });
    expect(w?.origin).toMatchObject({ kind: 'kubeflow-pipeline', run: 'lora-2', task: 'evaluate', url: 'http://127.0.0.1:18399/#/runs/details/732b10b3' });
    expect(w?.artifacts.map((a) => [a.direction, a.name, a.producedBy])).toEqual([
      ['input', 'adapter', 'dev-lora-pipeline-train-eouku'], ['input', 'base-model', ''], ['output', 'eval', '']
    ]);
  });

  it('links only to a web page', () => {
    const job = JSON.parse(JSON.stringify(evalJob));

    job.metadata.annotations['ai-factory.suse.com/origin'] = JSON.stringify({ kind: 'kubeflow-pipeline', run: 'x', url: 'javascript:alert(1)' });
    expect(workflowOf(job)?.origin?.url).toBe('');
  });

  it('nothing for a run submitted on its own, or a record that cannot be read', () => {
    expect(workflowOf({ metadata: { name: 'r', labels: {}, annotations: {} } })).toBeNull();
    expect(workflowOf({ metadata: { name: 'r', annotations: { 'ai-factory.suse.com/artifacts': 'not json' } } })).toBeNull();
    expect(workflowOf(null)).toBeNull();
  });
});

describe('shortUri and originText', () => {
  it('reads as the volume and path, or the model at a short commit', () => {
    expect(shortUri('volume://t-checkpoints/t/adapter')).toBe('t-checkpoints: t/adapter');
    expect(shortUri('hf://Qwen/Qwen2.5-0.5B-Instruct@7ae557604adf67be50417f59c2c2f167def9a775')).toBe('Qwen/Qwen2.5-0.5B-Instruct @ 7ae55760');
    expect(shortUri('hf-dataset://yahma/alpaca-cleaned@12567cabf869/alpaca_data_cleaned.json')).toBe('yahma/alpaca-cleaned @ 12567cab alpaca_data_cleaned.json');
    expect(originText({ kind: 'kubeflow-pipeline', name: 'lora-train-evaluate-publish', run: '', task: '', url: '' })).toBe('Kubeflow pipeline lora-train-evaluate-publish');
  });
});
