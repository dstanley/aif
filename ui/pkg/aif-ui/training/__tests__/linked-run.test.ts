import { describe, expect, it } from 'vitest';
import { linkedRun } from '../runs';

describe('the run a link names', () => {
  const runs = [{ name: 'dev-smoke', key: 'a' }, { name: 'dev-smoke-kept', key: 'b' }, { name: 'twice', key: 'c' }, { name: 'twice', key: 'd' }];

  it('is the run with exactly that name, not one that only contains it', () => {
    expect(linkedRun(runs, 'dev-smoke')?.key).toBe('a');
  });

  it('is none for no name, an unknown one, or a name two runs share', () => {
    expect(linkedRun(runs, '')).toBeNull();
    expect(linkedRun(runs, 'nope')).toBeNull();
    expect(linkedRun(runs, 'twice')).toBeNull();
  });
});
