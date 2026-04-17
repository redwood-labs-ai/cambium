/**
 * Substrate registry — one instance per runner process.
 *
 * The `execute_code` handler reads `ir.policies.security.exec.runtime`,
 * looks up the substrate here, and dispatches. `checkRuntime()` is
 * called once at runner startup for any runtime the gen declares;
 * if the substrate isn't available, the runner fails fast with the
 * `available()` reason string rather than degrading silently.
 */
import type { ExecSubstrate, SubstrateName, SubstrateRegistry } from './types.js';
import { NativeSubstrate } from './native.js';
import { WasmSubstrate } from './wasm.js';
import { FirecrackerSubstrate } from './firecracker.js';

/** Known substrate names. The list is load-bearing — see `getSubstrate`
 *  for why we check against it explicitly rather than property-accessing
 *  the registry directly. */
const KNOWN_SUBSTRATES: readonly SubstrateName[] = ['wasm', 'firecracker', 'native'] as const;

/** Type-guard for substrate names. Used at every policy boundary so a
 *  tampered or malformed IR can't smuggle `'__proto__'` or `'toString'`
 *  through the prototype chain. */
export function isKnownSubstrate(name: string): name is SubstrateName {
  return (KNOWN_SUBSTRATES as readonly string[]).includes(name);
}

let _registry: SubstrateRegistry | null = null;

export function getSubstrateRegistry(): SubstrateRegistry {
  if (_registry) return _registry;
  _registry = {
    native: new NativeSubstrate(),
    wasm: new WasmSubstrate(),
    firecracker: new FirecrackerSubstrate(),
  };
  return _registry;
}

export function getSubstrate(name: SubstrateName): ExecSubstrate {
  // Explicit allowlist check BEFORE any property access on the
  // registry. `Object.hasOwn` would also work here, but an explicit
  // enum check is harder to get wrong under refactor — a new substrate
  // has to be named in KNOWN_SUBSTRATES to be lookupable. Without this
  // guard, a value like `'__proto__'` or `'toString'` flowing in from
  // a tampered IR would return the Object prototype / a method via
  // the registry's property chain, sidestepping the `!sub` check.
  if (!isKnownSubstrate(name)) {
    throw new Error(
      `Unknown exec substrate: "${name}". Known: ${KNOWN_SUBSTRATES.join(', ')}.`,
    );
  }
  const reg = getSubstrateRegistry();
  return reg[name];
}

/**
 * Probe a substrate at runner startup. Throws with the substrate's own
 * reason string if it's not available on this host. Call once per
 * runtime the runner plans to dispatch to; the underlying
 * `available()` call caches its own result.
 */
export function checkRuntime(name: SubstrateName): void {
  const sub = getSubstrate(name);
  const reason = sub.available();
  if (reason !== null) {
    throw new Error(
      `Exec substrate "${name}" is not available on this host: ${reason}`,
    );
  }
}

/** Test hook: reset the registry so tests can inject fake substrates. */
export function _resetRegistryForTests(): void {
  _registry = null;
}
