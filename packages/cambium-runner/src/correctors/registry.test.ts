import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  correctors,
  registerAppCorrectors,
  runCorrectorPipeline,
  _resetAppCorrectorsForTests,
} from './index.js';
import type { CorrectorFn } from './types.js';

const BUILTINS = ['math', 'dates', 'currency', 'citations'];

describe('registerAppCorrectors (RED-275)', () => {
  afterEach(() => {
    _resetAppCorrectorsForTests(BUILTINS);
    vi.restoreAllMocks();
  });

  it('adds a new corrector to the registry', () => {
    const fn: CorrectorFn = (data) => ({ corrected: false, output: data, issues: [] });
    registerAppCorrectors({ my_corrector: fn });
    expect(correctors.my_corrector).toBe(fn);
  });

  it('overrides a built-in with a stderr warning', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn: CorrectorFn = (data) => ({ corrected: false, output: data, issues: [] });
    registerAppCorrectors({ math: fn });
    expect(correctors.math).toBe(fn);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"math" overrides the framework built-in'));
  });

  it('warns once per overridden name per process', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn: CorrectorFn = (data) => ({ corrected: false, output: data, issues: [] });
    registerAppCorrectors({ math: fn });
    registerAppCorrectors({ math: fn });
    registerAppCorrectors({ math: fn });
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves built-ins untouched when registering non-colliding names', () => {
    const fn: CorrectorFn = (data) => ({ corrected: true, output: { fixed: true }, issues: [] });
    registerAppCorrectors({ new_name: fn });
    for (const b of BUILTINS) {
      expect(correctors[b]).toBeTypeOf('function');
    }
  });
});

describe('runCorrectorPipeline throw-wrapping (RED-275)', () => {
  afterEach(() => _resetAppCorrectorsForTests(BUILTINS));

  it('wraps a throwing corrector as an error-severity issue instead of crashing', () => {
    const boom: CorrectorFn = () => {
      throw new Error('boom');
    };
    registerAppCorrectors({ boom });
    const { data, results } = runCorrectorPipeline(['boom'], { v: 1 }, {});
    expect(data).toEqual({ v: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].corrected).toBe(false);
    expect(results[0].issues).toEqual([
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('boom') }),
    ]);
  });

  it('still throws on an unknown corrector name (config bug, not runtime)', () => {
    expect(() => runCorrectorPipeline(['nope'], {}, {})).toThrow(/Unknown corrector/);
  });

  it('continues running later correctors after an earlier one throws', () => {
    const boom: CorrectorFn = () => {
      throw new Error('boom');
    };
    const ok: CorrectorFn = (data) => ({
      corrected: true,
      output: { ...data, added: true },
      issues: [],
    });
    registerAppCorrectors({ boom, ok });
    const { data, results } = runCorrectorPipeline(['boom', 'ok'], { v: 1 }, {});
    expect(data).toEqual({ v: 1, added: true });
    expect(results).toHaveLength(2);
    expect(results[0].corrected).toBe(false);
    expect(results[1].corrected).toBe(true);
  });
});
