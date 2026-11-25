/**
 * A deep copy of a module's state, for an engine snapshot. Plain objects, arrays, Maps and Sets
 * are copied, a value reached twice is copied once, and functions, such as a ping's listener,
 * are kept as they are. Anything else is a bug in the module, so it throws.
 */
export function cloneState<T>(value: T): T {
  return copy(value, new Map()) as T;
}

function copy(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const done = seen.get(value);
  if (done !== undefined) return done;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(copy(item, seen));
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [key, item] of value) out.set(copy(key, seen), copy(item, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const item of value) out.add(copy(item, seen));
    return out;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Module state must be plain data, got ${value.constructor.name}`);
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) out[key] = copy(item, seen);
  return out;
}
