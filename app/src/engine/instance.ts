// Singleton access to the running engine for UI and other modules.
import type { Engine } from './Engine';

let current: Engine | null = null;
const waiters: ((e: Engine) => void)[] = [];

export function setEngine(e: Engine | null) {
  current = e;
  if (e) waiters.splice(0).forEach((w) => w(e));
}

export function getEngine(): Engine | null {
  return current;
}

/** Resolves once the engine is initialised (use this from layers/UI). */
export function whenEngine(): Promise<Engine> {
  return current ? Promise.resolve(current) : new Promise((r) => waiters.push(r));
}
