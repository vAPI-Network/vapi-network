export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Value is not JSON serializable");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Value is not JSON serializable");
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalizeJson(item)]),
    );
  }
  throw new Error("Value is not JSON serializable");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}
