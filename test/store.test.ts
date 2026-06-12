import { describe, it, expect } from "vitest";
import { mergePatch, recipeDiff } from "../src/core/store.js";
import { parseSoundRef } from "../src/core/soundref.js";
import { canonicalJson } from "../src/core/cache.js";
import { validateOrThrow, recipeSchema, ValidationError } from "../src/schema.js";

describe("mergePatch (RFC 7386)", () => {
  // test vectors from the RFC appendix
  const vectors: [unknown, unknown, unknown][] = [
    [{ a: "b" }, { a: "c" }, { a: "c" }],
    [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
    [{ a: "b" }, { a: null }, {}],
    [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
    [{ a: ["b"] }, { a: "c" }, { a: "c" }],
    [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
    [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
    [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
    [["a", "b"], ["c", "d"], ["c", "d"]],
    [{ a: "b" }, ["c"], ["c"]],
    [{ a: "foo" }, null, null],
    [{ a: "foo" }, "bar", "bar"],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: "b", c: null }, { a: "b" }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];
  it("passes all RFC test vectors", () => {
    for (const [target, patch, want] of vectors) {
      expect(mergePatch(target, patch)).toEqual(want);
    }
  });
});

describe("recipeDiff", () => {
  it("reports changed paths with from and to", () => {
    const rows = recipeDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: 4 });
    expect(rows).toContainEqual({ path: "/b/c", from: 2, to: 3 });
    expect(rows).toContainEqual({ path: "/d", from: undefined, to: 4 });
  });
});

describe("soundref", () => {
  it("parses all forms", () => {
    expect(parseSoundRef("stone_impact")).toEqual({ kind: "recipe", name: "stone_impact", version: undefined, variant: undefined });
    expect(parseSoundRef("stone_impact@3")).toEqual({ kind: "recipe", name: "stone_impact", version: 3, variant: undefined });
    expect(parseSoundRef("stone_impact#2")).toEqual({ kind: "recipe", name: "stone_impact", version: undefined, variant: 2 });
    expect(parseSoundRef("stone_impact@3#2")).toEqual({ kind: "recipe", name: "stone_impact", version: 3, variant: 2 });
    expect(parseSoundRef("refs/target.wav")).toEqual({ kind: "ref", file: "refs/target.wav" });
  });
  it("rejects traversal and junk", () => {
    expect(() => parseSoundRef("refs/../project.json")).toThrow();
    expect(() => parseSoundRef("no spaces")).toThrow();
  });
});

describe("canonicalJson", () => {
  it("is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
  });
});

describe("schema validation error model", () => {
  const base = {
    name: "t",
    duration_ms: 500,
    layers: [{ id: "a", source: { type: "noise" } }],
  };
  it("fills defaults", () => {
    const recipe = validateOrThrow(recipeSchema, base);
    expect(recipe.layers[0].envelope.sustain).toBe(1);
    expect(recipe.master.gain_db).toBe(0);
    expect(recipe.loop.enabled).toBe(false);
  });
  it("names the JSON pointer and offending value", () => {
    try {
      validateOrThrow(recipeSchema, {
        ...base,
        layers: [{ id: "a", source: { type: "noise" }, filters: [{ type: "bandpass", cutoff_hz: 24000 }] }],
      });
      expect.unreachable();
    } catch (err) {
      const detail = (err as ValidationError).detail;
      expect(detail.error).toBe("validation");
      expect(detail.path).toBe("/layers/0/filters/0/cutoff_hz");
      expect(detail.got).toBe(24000);
    }
  });
  it("rejects duplicate layer ids", () => {
    expect(() =>
      validateOrThrow(recipeSchema, {
        ...base,
        layers: [
          { id: "a", source: { type: "noise" } },
          { id: "a", source: { type: "noise" } },
        ],
      }),
    ).toThrow(/duplicate/);
  });
  it("rejects modal without preset or modes", () => {
    expect(() =>
      validateOrThrow(recipeSchema, { ...base, layers: [{ id: "m", source: { type: "modal" } }] }),
    ).toThrow(/preset or modes/);
  });
});
