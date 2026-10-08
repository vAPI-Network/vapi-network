import { describe, expect, it } from "vitest";

import { canonicalizeJson, canonicalJson } from "./canonical-json.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively by code point while preserving array order", () => {
    const value = {
      z: [{ ä: 1, z: 2, a: 3 }, null],
      a: { beta: true, alpha: "first" },
    };

    expect(canonicalJson(value)).toBe(
      '{"a":{"alpha":"first","beta":true},"z":[{"a":3,"z":2,"ä":1},null]}',
    );
  });

  it("accepts JSON primitives and null-prototype objects", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, {
      b: 2,
      a: 1,
    });

    expect(canonicalizeJson(value)).toEqual({ a: 1, b: 2 });
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(12.5)).toBe("12.5");
    expect(canonicalJson("text")).toBe('"text"');
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    new Date(0),
    new Map(),
    new (class Example {
      value = 1;
    })(),
    undefined,
    () => undefined,
    { nested: undefined },
    [() => undefined],
  ])("rejects a non-JSON value: %s", (value) => {
    expect(() => canonicalJson(value)).toThrow("Value is not JSON serializable");
  });
});
