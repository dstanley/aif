import { describe, expect, it } from 'vitest';
import { failureOf, parseResult, reportResult } from '../results';

describe('parseResult', () => {
  const line = (r: any) => `AIF_RESULT ${ JSON.stringify(r) }`;

  it('reads the last result line, whatever precedes it', () => {
    const log = ['step 1', line({ test: 'old', status: 'pass' }), '[rank0]: ' + line({
      test: 'PyTorch GPU Test', status: 'pass', checks: [{ name: 'CUDA available', ok: true, detail: '1 device' }], metrics: { 'FP16 matmul': '12.1 TFLOPS' }, env: { torch: '2.5.1' }
    })].join('\n');
    const r = parseResult(log)!;

    expect(r.test).toBe('PyTorch GPU Test');
    expect(r.checks).toEqual([{ name: 'CUDA available', ok: true, detail: '1 device' }]);
    expect(r.metrics['FP16 matmul']).toBe('12.1 TFLOPS');
  });

  it('fails a result with a failed check, whatever its status says', () => {
    expect(parseResult(line({ status: 'pass', checks: [{ name: 'x', ok: false }] }))!.status).toBe('fail');
  });

  it('is null without a result or with a malformed one', () => {
    expect(parseResult('training… done')).toBeNull();
    expect(parseResult('AIF_RESULT {not json')).toBeNull();
  });
});

describe('warnings', () => {
  it('flag a check without failing the result', () => {
    const r = parseResult('AIF_RESULT ' + JSON.stringify({ status: 'pass', checks: [{ name: 'PCIe link width', ok: true, warn: true, detail: 'x8 of x16' }] }))!;

    expect(r.status).toBe('pass');
    expect(r.checks[0]).toEqual({ name: 'PCIe link width', ok: true, warn: true, detail: 'x8 of x16' });
  });
});

describe('reportResult', () => {
  it('reads the result an AIJob kept, with the same verdict rules as a log line', () => {
    const aiJob = {
      status: {
        report: {
          test: 'GPU Smoke Test', status: 'pass', checks: [{ name: 'GPU allocated', ok: true }, { name: 'Persistence mode', ok: true, warn: true }], metrics: { 'GPU memory (MiB)': '1105' }, env: { node: 'worker-1' }
        }
      }
    };
    const r = reportResult(aiJob)!;

    expect(r.test).toBe('GPU Smoke Test');
    expect(r.status).toBe('pass');
    expect(r.checks[1].warn).toBe(true);
    expect(r.env.node).toBe('worker-1');
    expect(reportResult({ status: { report: { test: 'x', status: 'pass', checks: [{ name: 'a', ok: false }] } } })!.status).toBe('fail');
  });

  it('is nothing for a run without one, or something that is not an AIJob', () => {
    expect(reportResult({ status: {} })).toBeNull();
    expect(reportResult({ spec: { chart: {} } })).toBeNull();
    expect(reportResult(null)).toBeNull();
  });
});

describe('failureOf', () => {
  const invalid = '1 error occurred:\n\t* Job.batch "train-hi736" is invalid: spec.template.spec.containers[0].resources.requests: Invalid value: "16Gi": must be less than or equal to memory limit of 8Gi\n\n';

  it('a run refused at install says why, though it never had a pod', () => {
    const f = failureOf({ status: { phase: 'Failed', result: { reason: 'InstallFailed', message: invalid } } });

    expect(f).toMatchObject({ title: 'The run could not be installed', reason: 'InstallFailed', waiting: false });
    expect(f?.message).toBe('Job.batch "train-hi736" is invalid: spec.template.spec.containers[0].resources.requests: Invalid value: "16Gi": must be less than or equal to memory limit of 8Gi');
  });

  it('a run that failed later gives its reason too', () => {
    expect(failureOf({ status: { phase: 'Failed', result: { reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' } } }))
      .toMatchObject({ title: 'The run failed', message: 'Job has reached the specified backoff limit' });
  });

  it('an install the operator is still retrying shows as waiting', () => {
    const f = failureOf({ status: { phase: 'Pending', conditions: [
      { type: 'Ready', status: 'False', reason: 'Waiting', message: 'not yet' },
      { type: 'Installed', status: 'False', reason: 'InstallFailed', message: 'chart gpu-train-job not found' },
    ] } });

    expect(f).toMatchObject({ title: 'The run cannot start yet', waiting: true, message: 'chart gpu-train-job not found' });
  });

  it('nothing for a run that is fine, finished, or not an AIJob', () => {
    expect(failureOf({ status: { phase: 'Running', conditions: [{ type: 'Installed', status: 'True', reason: 'Installed' }] } })).toBeNull();
    expect(failureOf({ status: { phase: 'Completed', result: { reason: 'Succeeded' } } })).toBeNull();
    expect(failureOf({ status: { phase: 'Failed' } })).toBeNull();
    expect(failureOf({ kind: 'Job', status: { succeeded: 1 } })).toBeNull();
    expect(failureOf(null)).toBeNull();
  });
});
