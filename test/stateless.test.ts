/**
 * Stateless rendering (preview path): renderRecipe takes an inline validated
 * recipe through the content-addressed cache without touching sounds/ or
 * history/, and shares cache entries with the stored path so previewing then
 * committing the identical document costs one render.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { recipeSchema, validateOrThrow, Recipe } from "../src/schema.js";
import { Workspace } from "../src/core/workspace.js";
import { RecipeStore } from "../src/core/store.js";
import { Renderer } from "../src/core/renderer.js";

let root: string;
let ws: Workspace;
let store: RecipeStore;
let renderer: Renderer;

const blip = {
  name: "blip",
  duration_ms: 200,
  layers: [
    {
      id: "tone",
      source: { type: "osc", shape: "sine", freq_hz: 880 },
      envelope: { attack_ms: 1, decay_ms: 100, sustain: 0, curve: "exp" },
    },
  ],
};

function parseRecipe(r: unknown): Recipe {
  return validateOrThrow(recipeSchema, r);
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mixdown-stateless-"));
  ws = new Workspace(root);
  await ws.init();
  store = new RecipeStore(ws);
  renderer = new Renderer(ws, store);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("stateless render", () => {
  it("renders an inline recipe without writing to the store", async () => {
    const sound = await renderer.renderRecipe(parseRecipe(blip));
    expect(sound.cached).toBe(false);
    expect(sound.version).toBeUndefined();
    expect(sound.bundle.duration_ms).toBeGreaterThan(0);
    await fs.access(ws.resolve(sound.file)); // wav landed in renders/
    expect(await store.listNames()).toEqual([]);
    expect(await fs.readdir(path.join(root, "history"))).toEqual([]);
  });

  it("shares the cache with the stored path", async () => {
    const inline = await renderer.renderRecipe(parseRecipe(blip));
    expect(inline.cached).toBe(true); // hit from the previous test's render

    await store.write("blip", blip);
    const stored = await renderer.renderRecipeVersion("blip");
    expect(stored.cached).toBe(true); // identical content, same cache key
    expect(stored.file).toBe(inline.file);
    expect(stored.version).toBe(1);
  });

  it("renders variants from an inline variants block", async () => {
    const withVariants = parseRecipe({ ...blip, name: "blip_v", variants: { count: 2, jitter: { pitch_semitones: 1 } } });
    const v1 = await renderer.renderRecipe(withVariants, { variant: 1 });
    const v2 = await renderer.renderRecipe(withVariants, { variant: 2 });
    expect(v1.variant).toBe(1);
    expect(v1.file).not.toBe(v2.file);
    expect(await store.listNames()).toEqual(["blip"]); // still only the committed sound
  });

  it("rejects an out-of-range variant", async () => {
    await expect(renderer.renderRecipe(parseRecipe(blip), { variant: 1 })).rejects.toThrow(/no variants/);
  });
});
