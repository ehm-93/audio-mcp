/** v0.2 features: DC fixes, LFO, breakpoint pitch env, segment curves, tail ring-out, master fades, patch_layer, lint allow. */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { renderOsc } from "../src/dsp/osc.js";
import { renderModal } from "../src/dsp/modal.js";
import { applyEnvelope } from "../src/dsp/envelope.js";
import { renderRecipe, ENGINE_VERSION } from "../src/dsp/engine.js";
import { dcOffsetDb, rmsEnvelopeDb } from "../src/analysis/measure.js";
import { stft, centroidTrajectory } from "../src/analysis/spectral.js";
import { recipeSchema, projectSchema, validateOrThrow, Recipe } from "../src/schema.js";
import { applyLayerPatch } from "../src/core/store.js";
import { Workspace } from "../src/core/workspace.js";
import { RecipeStore } from "../src/core/store.js";
import { Renderer } from "../src/core/renderer.js";
import { AudioBuf } from "../src/dsp/buffer.js";

const SR = 44100;
const project = projectSchema.parse({});
const noRefs = { project, loadRef: async () => Promise.reject(new Error("no refs in this test")) };

function parseRecipe(r: unknown): Recipe {
  return validateOrThrow(recipeSchema, r);
}

describe("DC fixes", () => {
  it("pulse at 20% duty has no DC offset", () => {
    const out = renderOsc(SR, SR, "pulse", 110, 0.2);
    const buf: AudioBuf = { sampleRate: SR, channels: [out] };
    expect(dcOffsetDb(buf)).toBeLessThan(-40);
  });
  it("impulse-excited modal has no DC offset", () => {
    const out = renderModal(Math.round(0.16 * SR), SR, [{ freq_hz: 175, decay_ms: 130, gain_db: 0 }], "impulse", 5, 1);
    const buf: AudioBuf = { sampleRate: SR, channels: [out] };
    expect(dcOffsetDb(buf)).toBeLessThan(-60);
  });
});

describe("pitch envelope breakpoints", () => {
  it("rises then falls", () => {
    const out = renderOsc(Math.round(0.2 * SR), SR, "sine", 440, 0.5, {
      points: [
        { at: 0, semitones: 0 },
        { at: 0.5, semitones: 12 },
        { at: 1, semitones: 0 },
      ],
      curve: "lin",
    });
    const traj = centroidTrajectory(stft({ sampleRate: SR, channels: [out] }));
    expect(traj.at_100ms!).toBeGreaterThan(traj.at_10ms! * 1.4); // mid is ~an octave up
    expect(traj.at_end!).toBeLessThan(traj.at_100ms! * 0.75); // falls back down
  });
  it("schema rejects both end_semitones and points", () => {
    expect(() =>
      parseRecipe({
        name: "x",
        duration_ms: 100,
        layers: [
          {
            id: "a",
            source: { type: "osc", shape: "sine", freq_hz: 440, pitch_env: { end_semitones: 5, points: [{ at: 0, semitones: 0 }, { at: 1, semitones: 5 }] } },
          },
        ],
      }),
    ).toThrow(/exactly one/);
  });
});

describe("LFO", () => {
  it("gain LFO produces tremolo at depth", async () => {
    const recipe = parseRecipe({
      name: "trem",
      duration_ms: 1000,
      seed: 1,
      layers: [
        {
          id: "tone",
          source: { type: "osc", shape: "sine", freq_hz: 1000 },
          lfo: { target: "gain", rate_hz: 4, depth: 10 },
          gain_db: -6,
        },
      ],
    });
    const { mix } = await renderRecipe(recipe, noRefs);
    const env = rmsEnvelopeDb(mix);
    // ignore edges; the middle should swing close to +-10 dB
    const mid = Array.from(env.db.slice(50, env.db.length - 50));
    const swing = Math.max(...mid) - Math.min(...mid);
    expect(swing).toBeGreaterThan(12);
  });
  it("accelerating rate changes the output vs constant rate", async () => {
    const base = {
      name: "acc",
      duration_ms: 500,
      seed: 1,
      layers: [
        { id: "t", source: { type: "osc", shape: "sine", freq_hz: 800 }, lfo: { target: "gain", rate_hz: 2, depth: 8 }, gain_db: -6 },
      ],
    };
    const a = await renderRecipe(parseRecipe(base), noRefs);
    const accel = JSON.parse(JSON.stringify(base));
    accel.layers[0].lfo.rate_end_hz = 20;
    const b = await renderRecipe(parseRecipe(accel), noRefs);
    expect(Buffer.from(a.mix.channels[0].buffer).equals(Buffer.from(b.mix.channels[0].buffer))).toBe(false);
  });
  it("schema rejects pitch LFO on noise and cutoff LFO without filters", () => {
    expect(() =>
      parseRecipe({
        name: "x",
        duration_ms: 100,
        layers: [{ id: "a", source: { type: "noise" }, lfo: { target: "pitch", rate_hz: 5, depth: 2 } }],
      }),
    ).toThrow(/osc source/);
    expect(() =>
      parseRecipe({
        name: "x",
        duration_ms: 100,
        layers: [{ id: "a", source: { type: "noise" }, lfo: { target: "cutoff", rate_hz: 5, depth: 20 } }],
      }),
    ).toThrow(/filter/);
  });
});

describe("per-segment envelope curves", () => {
  it("release_curve overrides the shared curve", () => {
    const mkBuf = () => new Float32Array(SR).fill(1);
    const logBoth = mkBuf();
    applyEnvelope(logBoth, SR, { attack_ms: 100, hold_ms: 0, decay_ms: 0, sustain: 1, release_ms: 100, curve: "log" });
    const logAttackLinRelease = mkBuf();
    applyEnvelope(logAttackLinRelease, SR, {
      attack_ms: 100, hold_ms: 0, decay_ms: 0, sustain: 1, release_ms: 100, curve: "log", release_curve: "lin",
    });
    // 5 ms before the end, a log release still hangs high while lin is nearly silent
    const i = SR - Math.round(0.005 * SR);
    expect(logBoth[i]).toBeGreaterThan(0.2);
    expect(logAttackLinRelease[i]).toBeLessThan(0.1);
    // attack halves identical (both log)
    expect(logAttackLinRelease[Math.round(0.05 * SR)]).toBeCloseTo(logBoth[Math.round(0.05 * SR)], 6);
  });
});

describe("tail ring-out and master fades", () => {
  it("delay rings out past duration_ms and decays to silence", async () => {
    const recipe = parseRecipe({
      name: "ring",
      duration_ms: 300,
      seed: 1,
      layers: [{ id: "t", source: { type: "osc", shape: "sine", freq_hz: 700 }, gain_db: -6 }],
      bus: [{ type: "delay", time_ms: 100, feedback: 0.5, wet: 0.5 }],
    });
    const { mix } = await renderRecipe(recipe, noRefs);
    const n = mix.channels[0].length;
    expect(n).toBeGreaterThan(0.35 * SR); // extended past 300 ms
    expect(Math.abs(mix.channels[0][n - 1])).toBeLessThan(0.02); // ends near silence, no click
  });
  it("loops are not extended", async () => {
    const recipe = parseRecipe({
      name: "lp",
      duration_ms: 1000,
      seed: 1,
      layers: [{ id: "t", source: { type: "osc", shape: "sine", freq_hz: 220 }, gain_db: -12 }],
      bus: [{ type: "delay", time_ms: 50, feedback: 0.4, wet: 0.3 }],
      loop: { enabled: true, crossfade_ms: 100 },
    });
    const { mix } = await renderRecipe(recipe, noRefs);
    expect(mix.channels[0].length).toBe(Math.round(0.9 * SR));
  });
  it("master fades shape the output ends", async () => {
    const recipe = parseRecipe({
      name: "fade",
      duration_ms: 500,
      seed: 1,
      layers: [{ id: "t", source: { type: "osc", shape: "sine", freq_hz: 500 }, gain_db: -6 }],
      master: { gain_db: 0, fade_in_ms: 150, fade_out_ms: 150 },
    });
    const { mix } = await renderRecipe(recipe, noRefs);
    const ch = mix.channels[0];
    let headPeak = 0;
    for (let i = 0; i < Math.round(0.02 * SR); i++) headPeak = Math.max(headPeak, Math.abs(ch[i]));
    let midPeak = 0;
    for (let i = Math.round(0.2 * SR); i < Math.round(0.3 * SR); i++) midPeak = Math.max(midPeak, Math.abs(ch[i]));
    expect(headPeak).toBeLessThan(midPeak * 0.3);
    expect(Math.abs(ch[ch.length - 1])).toBeLessThan(0.01);
  });
  it("schema rejects fades on loops", () => {
    expect(() =>
      parseRecipe({
        name: "x",
        duration_ms: 1000,
        layers: [{ id: "a", source: { type: "noise" } }],
        loop: { enabled: true },
        master: { fade_in_ms: 100 },
      }),
    ).toThrow(/seam/);
  });
});

describe("applyLayerPatch", () => {
  const recipe = parseRecipe({
    name: "p",
    duration_ms: 100,
    layers: [
      { id: "a", source: { type: "noise" }, gain_db: -6 },
      { id: "b", source: { type: "noise" }, gain_db: -3 },
    ],
  });
  it("patches one layer in place", () => {
    const out = applyLayerPatch(recipe, "b", { gain_db: -9 }) as Recipe;
    expect(out.layers[1].gain_db).toBe(-9);
    expect(out.layers[0].gain_db).toBe(-6);
    expect(out.layers.length).toBe(2);
  });
  it("null removes the layer", () => {
    const out = applyLayerPatch(recipe, "a", null) as Recipe;
    expect(out.layers.length).toBe(1);
    expect(out.layers[0].id).toBe("b");
  });
  it("unknown id names the available layers", () => {
    expect(() => applyLayerPatch(recipe, "zz", {})).toThrow(/a, b/);
  });
});

describe("lint allow-list", () => {
  let root: string;
  let renderer: Renderer;
  let store: RecipeStore;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mixdown-v02-"));
    const ws = new Workspace(root);
    await ws.init();
    store = new RecipeStore(ws);
    renderer = new Renderer(ws, store);
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("suppresses allowed findings and reports them separately", async () => {
    const blip = {
      name: "blip",
      duration_ms: 1000,
      seed: 1,
      layers: [
        {
          id: "b",
          source: { type: "osc", shape: "sine", freq_hz: 880 },
          envelope: { attack_ms: 1, decay_ms: 80, sustain: 0, curve: "exp" },
          gain_db: -6,
        },
      ],
    };
    await store.write("blip", blip);
    const plain = await renderer.renderRecipeVersion("blip");
    expect(plain.findings.some((f) => f.code === "W202")).toBe(true);

    await store.write("blip", { ...blip, lint: { allow: ["W202"] } });
    const allowed = await renderer.renderRecipeVersion("blip");
    expect(allowed.findings.some((f) => f.code === "W202")).toBe(false);
    expect(allowed.suppressed.some((f) => f.code === "W202")).toBe(true);
  });

  it("engine version is 0.2.0", () => {
    expect(ENGINE_VERSION).toMatch(/^0\.2\.0-node\d+/);
  });
});
