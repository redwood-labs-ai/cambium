import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  builtinCorrectors,
  registerAppCorrectors,
  runCorrectorPipeline,
  _getLegacyAppCorrectors,
  _resetLegacyCorrectorsForTests,
} from './index.js';
import type { CorrectorFn } from './types.js';

// RED-299: `registerAppCorrectors` remains as a deprecated back-compat
// shim. These tests assert the shim still behaves correctly — the
// deprecation warning, the override warning, the one-time rule — so
// any hypothetical external caller that hasn't migrated to
// RunGenOptions.correctors yet keeps working.

describe('registerAppCorrectors (RED-275, deprecated in RED-299)', () => {
  afterEach(() => {
    _resetLegacyCorrectorsForTests();
    vi.restoreAllMocks();
  });

  it('adds a new corrector to the legacy registry', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn: CorrectorFn = (data) => ({ corrected: false, output: data, issues: [] });
    registerAppCorrectors({ my_corrector: fn });
    expect(_getLegacyAppCorrectors().my_corrector).toBe(fn);
    // First call emits the RED-299 deprecation warning (one-time per process).
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('registerAppCorrectors is deprecated'),
    );
  });

  it('overrides a built-in with a stderr warning (RED-275 invariant preserved)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn: CorrectorFn = (data) => ({ corrected: false, output: data, issues: [] });
    registerAppCorrectors({ math: fn });
    expect(_getLegacyAppCorrectors().math).toBe(fn);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('"math" overrides the framework built-in'),
    );
  });

  it('warns once per overridden name per process', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn: CorrectorFn = (data) => ({ corrected: false, output: data, issues: [] });
    registerAppCorrectors({ math: fn });
    registerAppCorrectors({ math: fn });
    registerAppCorrectors({ math: fn });
    // Per-name override warning: exactly once. The RED-299 deprecation
    // warning fires once too, so total is 2 calls (not 3+).
    const overrideWarns = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('overrides the framework built-in'),
    );
    expect(overrideWarns).toHaveLength(1);
  });

  it('does not touch the read-only builtinCorrectors export', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn: CorrectorFn = (data) => ({ corrected: true, output: data, issues: [] });
    registerAppCorrectors({ math: fn });
    // Legacy app map carries the override; the built-ins export remains
    // the framework baseline. This is what lets a host build a clean
    // per-call map via `{ ...builtinCorrectors, ...theirs }`.
    expect(_getLegacyAppCorrectors().math).toBe(fn);
    expect(builtinCorrectors.math).not.toBe(fn);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('runCorrectorPipeline throw-wrapping (RED-275, refactored RED-299)', () => {
  it('wraps a throwing corrector as an error-severity issue instead of crashing', () => {
    const boom: CorrectorFn = () => {
      throw new Error('boom');
    };
    const { data, results } = runCorrectorPipeline(['boom'], { v: 1 }, {}, { boom });
    expect(data).toEqual({ v: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].corrected).toBe(false);
    expect(results[0].issues).toEqual([
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('boom') }),
    ]);
  });

  it('still throws on an unknown corrector name (config bug, not runtime)', () => {
    expect(() => runCorrectorPipeline(['nope'], {}, {}, {})).toThrow(/Unknown corrector/);
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
    const { data, results } = runCorrectorPipeline(['boom', 'ok'], { v: 1 }, {}, { boom, ok });
    expect(data).toEqual({ v: 1, added: true });
    expect(results).toHaveLength(2);
    expect(results[0].corrected).toBe(false);
    expect(results[1].corrected).toBe(true);
  });
});
