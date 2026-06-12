/** v0.3 features: strict/unknown-key discovery, master DC block, loudness none + per-recipe override, deterministic sample pitch + reverse. */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { renderRecipe, applyDcBlock, EngineContext } from "../src/dsp/engine.js";
import { varispeed } from "../src/dsp/resample.js";
import { dcOffsetDb, peakDbfs } from "../src/analysis/measure.js";
import { recipeSchema, projectSchema, loudnessSchema, validateOrThrow, collectUnknownKeys, Recipe } from "../src/schema.js";
import { Workspace } from "../src/core/workspace.js";
import { RecipeStore } from "../src/core/store.js";
import { Renderer } from "../src/core/renderer.js";
import { exportSound } from "../src/core/exporter.js";
import { AudioBuf } from "../src/dsp/buffer.js";

const SR = 44100;
const project = projectSchema.parse({});
const noRefs: EngineContext = { project, loadRef: async () => Promise.reject(new Error("no refs in this test")) };

function parseRecipe(r: unknown): Recipe {
  return validateOrThrow(recipeSchema, r);
}

/** A ramp 0..1 over n samples; sinc-reads at integer offsets are exact, so equality assertions hold. */
function ramp(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i / (n - 1);
  return out;
}

describe("unknown-key discovery (#1)", () => {
  it("catches the plural-container mistakes that silently drop data", () => {
    const keys = collectUnknownKeys({
      name: "x",
      duration_ms: 100,
      bus_effects: [{ type: "delay" }], // should be `bus`
      layers: [
        {
          id: "a",
          source: { type: "osc", shape: "sine", freq_hz: 440, frequency: 440 }, // `frequency` is not a field
          filter: [{ type: "lowpass", cutoff_hz: 1000 }], // should be `filters`
        },
      ],
    });
    expect(keys).toContain("/bus_effects");
    expect(keys).toContain("/layers/0/filter");
    expect(keys).toContain("/layers/0/source/frequency");
  });

  it("reports nothing for a clean recipe", () => {
    const clean = {
      name: "clean",
      duration_ms: 100,
      layers: [{ id: "a", source: { type: "noise", color: "pink" }, filters: [{ type: "lowpass", cutoff_hz: 1000 }] }],
      bus: [{ type: "waveshaper", drive_db: 6 }],
      loudness: { mode: "none" },
    };
    expect(collectUnknownKeys(clean)).toEqual([]);
  });
});

/** A 200 Hz tone of amplitude `amp` riding on a constant `bias` (DC), `secs` long. */
function biasedTone(bias: number, amp: number, secs: number): Float32Array {
  const n = Math.round(secs * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bias + amp * Math.sin((2 * Math.PI * 200 * i) / SR);
  return out;
}

describe("master DC block (#2)", () => {
  it("removes a moderate DC bias while preserving the tone", () => {
    const buf: AudioBuf = { sampleRate: SR, channels: [biasedTone(0.02, 0.3, 1.5)] };
    const before = dcOffsetDb(buf);
    applyDcBlock(buf);
    const after = dcOffsetDb(buf);
    expect(before).toBeGreaterThan(-40); // the ~-34 dBFS bias is plainly present
    expect(after).toBeLessThan(-60); // settled well below the E102 threshold
    expect(peakDbfs(buf)).toBeGreaterThan(-12); // the 200 Hz tone survives, not crushed
  });

  it("removes bus-originated DC at the master stage, toggled by master.dc_block", async () => {
    // a sample carrying DC no layer highpass could reach (the user's bus-waveshaper case)
    const refCtx: EngineContext = { project, loadRef: async () => ({ sampleRate: SR, channels: [biasedTone(0.02, 0.3, 1.5)] }) };
    const mk = (dc_block: boolean) =>
      parseRecipe({
        name: "dc",
        duration_ms: 1500,
        layers: [{ id: "s", source: { type: "sample", file: "refs/biased.wav" } }],
        master: { dc_block },
      });
    const on = await renderRecipe(mk(true), refCtx);
    const off = await renderRecipe(mk(false), refCtx);
    expect(Buffer.from(on.mix.channels[0].buffer).equals(Buffer.from(off.mix.channels[0].buffer))).toBe(false);
    expect(dcOffsetDb(off.mix)).toBeGreaterThan(-40); // bias passes straight through when off
    expect(dcOffsetDb(on.mix)).toBeLessThan(-55); // master block removes it when on
  });
});

describe("deterministic sample pitch and reverse (#4)", () => {
  it("varispeed at rate 1 with no envelope reproduces the input", () => {
    const r = ramp(1000);
    const out = varispeed(r, r.length, 1, () => 0);
    expect(out.length).toBe(r.length);
    let maxDiff = 0;
    for (let i = 0; i < r.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - r[i]));
    expect(maxDiff).toBeLessThan(1e-9); // sinc at integer offsets collapses to identity (bar float noise)
  });

  it("rate 0.5 slows playback, reading exact half-positions", () => {
    const r = ramp(1000);
    const out = varispeed(r, r.length, 0.5, () => 0);
    expect(out[20]).toBeCloseTo(r[10], 6); // pos = 0.5*i; even i lands on an integer, cutoff 1 = exact
    expect(out[0]).toBeCloseTo(r[0], 9);
  });

  it("rate 2 reads twice as fast and empties the tail", () => {
    const r = ramp(1000);
    const out = varispeed(r, r.length, 2, () => 0);
    // read head is at pos 20 by output index 10 — nearer r[20] than r[10]
    expect(Math.abs(out[10] - r[20])).toBeLessThan(Math.abs(out[10] - r[10]));
    expect(out[600]).toBe(0); // ran off the end of a 1000-sample input
  });

  it("an octave-up pitch envelope equals doubling the rate", () => {
    const r = ramp(1000);
    const byRate = varispeed(r, r.length, 2, () => 0);
    const byPitch = varispeed(r, r.length, 1, () => 12); // +12 semitones = 2x speed
    expect(Array.from(byPitch)).toEqual(Array.from(byRate));
  });

  it("reverse plays the sample backward through the engine", async () => {
    const n = Math.round(0.1 * SR);
    const r = ramp(n);
    const refCtx: EngineContext = { project, loadRef: async () => ({ sampleRate: SR, channels: [r] }) };
    const mk = (reverse: boolean) =>
      parseRecipe({
        name: "s",
        duration_ms: 100,
        layers: [{ id: "smp", source: { type: "sample", file: "refs/r.wav", reverse } }],
        master: { dc_block: false }, // the ramp is mostly DC; keep it intact for the comparison
      });
    const fwd = await renderRecipe(mk(false), refCtx);
    const rev = await renderRecipe(mk(true), refCtx);
    // reversed output is the forward output mirrored in time
    expect(rev.mix.channels[0][0]).toBeCloseTo(fwd.mix.channels[0][n - 1], 5);
    expect(rev.mix.channels[0][n - 1]).toBeCloseTo(fwd.mix.channels[0][0], 5);
  });

  it("schema accepts rate, reverse, and pitch_env on a sample", () => {
    const recipe = parseRecipe({
      name: "s",
      duration_ms: 200,
      layers: [
        {
          id: "smp",
          source: { type: "sample", file: "refs/x.wav", rate: 1.5, reverse: true, pitch_env: { end_semitones: 7, curve: "lin" } },
        },
      ],
    });
    const src = recipe.layers[0].source;
    expect(src.type).toBe("sample");
    if (src.type === "sample") {
      expect(src.rate).toBe(1.5);
      expect(src.reverse).toBe(true);
      expect(src.pitch_env?.end_semitones).toBe(7);
    }
  });
});

describe("loudness none + per-recipe override (#3)", () => {
  it("schema accepts none mode on project and recipe", () => {
    expect(loudnessSchema.parse({ mode: "none" }).mode).toBe("none");
    const recipe = parseRecipe({
      name: "x",
      duration_ms: 100,
      layers: [{ id: "a", source: { type: "noise" } }],
      loudness: { mode: "none" },
    });
    expect(recipe.loudness?.mode).toBe("none");
  });

  describe("export honors the effective loudness", () => {
    let root: string;
    let renderer: Renderer;
    let store: RecipeStore;
    let proj: typeof project;

    beforeAll(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "mixdown-v03-"));
      const ws = new Workspace(root);
      await ws.init();
      // project normalizes to a -1 dBFS peak
      proj = projectSchema.parse({ loudness: { mode: "peak", peak_db: -1 } });
      await fs.writeFile(ws.resolve("project.json"), JSON.stringify(proj));
      store = new RecipeStore(ws);
      renderer = new Renderer(ws, store);
    });
    afterAll(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    const quiet = {
      name: "quiet",
      duration_ms: 300,
      seed: 1,
      layers: [{ id: "t", source: { type: "osc", shape: "sine", freq_hz: 300 }, gain_db: -24 }],
    };

    it("project peak mode normalizes a quiet sound up to the target", async () => {
      await store.write("quiet", quiet);
      const sound = await renderer.renderRecipeVersion("quiet");
      const entry = await exportSound(renderer, proj, sound, "quiet", null, { format: "wav" });
      expect(entry.peak_db).toBeGreaterThan(-2); // pulled up to ~ -1
    });

    it("a recipe loudness:none opts out, preserving the rendered (quiet) level", async () => {
      await store.write("quiet", { ...quiet, loudness: { mode: "none" } });
      const sound = await renderer.renderRecipeVersion("quiet");
      const entry = await exportSound(renderer, proj, sound, "quiet", null, { format: "wav" });
      expect(entry.peak_db).toBeLessThan(-12); // left at the rendered level, not normalized
    });
  });
});
