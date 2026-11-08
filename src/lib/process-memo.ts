/**
 * A WeakMap shared by every copy of a module in this process. Next.js bundles
 * src/instrumentation.ts separately from the route handlers, so a module-level WeakMap would exist
 * once per bundle and work done at server start (the data warm-up) would not be reused by
 * requests. Keys are objects (cached level snapshots), so entries are released with them.
 */
export function processWeakMap<K extends object, V>(name: string): WeakMap<K, V> {
  const key = Symbol.for(`prospect-terminal.${name}`);
  const slots = globalThis as unknown as Record<symbol, WeakMap<K, V> | undefined>;
  return (slots[key] ??= new WeakMap<K, V>());
}
