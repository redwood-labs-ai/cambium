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
  const reg = getSubstrateRegistry();
  const sub = reg[name];
  if (!sub) {
    throw new Error(`Unknown exec substrate: "${name}". Known: ${Object.keys(reg).join(', ')}.`);
  }
  return sub;
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
