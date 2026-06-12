/**
 * End-to-end smoke test built around the spec's stone_impact example:
 * workspace init, palette, write/patch/version recipes, render with cache,
 * determinism, variants, export, audition page.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { Workspace } from "../src/core/workspace.js";
import { RecipeStore, mergePatch } from "../src/core/store.js";
import { Renderer } from "../src/core/renderer.js";
import { exportSound } from "../src/core/exporter.js";
import { generateAuditionPage } from "../src/core/audition.js";
import { encodeWav } from "../src/io/wav.js";
import { decodeAudio } from "../src/io/audio.js";
import { renderNoise } from "../src/dsp/noise.js";
import { applyEnvelope } from "../src/dsp/envelope.js";
import { worstSeverity } from "../src/analysis/lint.js";

let root: string;
let ws: Workspace;
let store: RecipeStore;
let renderer: Renderer;

const stoneImpact = {
  name: "stone_impact",
  description: "rock dropped on rock, medium size",
  duration_ms: 700,
  channels: "mono",
  seed: 41,
  layers: [
    {
      id: "crack",
      source: { type: "noise", color: "white" },
      filters: [
        { type: "bandpass", cutoff_hz: 3200, q: 1.2 },
        { type: "highpass", cutoff_hz: 800, q: 0.7 },
      ],
      envelope: { attack_ms: 1, decay_ms: 60, sustain: 0, curve: "exp" },
      gain_db: -6,
      delay_ms: 0,
    },
    {
      id: "body",
      source: { type: "modal", preset: "stone_large", excite: "impulse" },
      envelope: { attack_ms: 2, decay_ms: 350, sustain: 0, curve: "exp" },
      gain_db: 0,
      delay_ms: 4,
    },
  ],
  bus: [{ type: "reverb", ir: "cave_small", wet: 0.12 }],
  master: { gain_db: -4 },
  loop: { enabled: false },
  variants: {
    count: 5,
    jitter: { pitch_semitones: 0.7, gain_db: 1.0, layer_delay_ms: 5, cutoff_pct: 8 },
  },
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mixdown-test-"));
  ws = new Workspace(root);
  await ws.init();
  store = new RecipeStore(ws);
  renderer = new Renderer(ws, store);

  // synthetic IR: 200 ms of exponentially decaying noise
  const ir = renderNoise(Math.round(0.2 * 44100), "white", 99);
  applyEnvelope(ir, 44100, { attack_ms: 0, hold_ms: 0, decay_ms: 200, sustain: 0, release_ms: 0, curve: "exp" });
  await fs.writeFile(path.join(root, "refs", "ir_cave_small.wav"), encodeWav({ sampleRate: 44100, channels: [ir] }, "float32"));

  // project palette per the spec example
  const project = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  project.palette = {
    resonators: {
      stone_large: {
        modes: [
          { freq_hz: 180, decay_ms: 300, gain_db: 0 },
          { freq_hz: 312, decay_ms: 220, gain_db: -4 },
          { freq_hz: 740, decay_ms: 120, gain_db: -9 },
        ],
      },
    },
    irs: { cave_small: "refs/ir_cave_small.wav" },
  };
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify(project, null, 2));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

describe("end to end", () => {
  it("writes the spec example recipe and renders it", async () => {
    const { version } = await store.write("stone_impact", stoneImpact);
    expect(version).toBe(1);

    const start = performance.now();
    const sound = await renderer.renderRecipeVersion("stone_impact");
    const elapsed = performance.now() - start;
    console.log(`first render: ${Math.round(elapsed)} ms, lint: ${worstSeverity(sound.findings)}`);

    expect(sound.cached).toBe(false);
    // reverb tail rings out past duration_ms, then trims at silence
    expect(sound.bundle.duration_ms).toBeGreaterThanOrEqual(700);
    expect(sound.bundle.duration_ms).toBeLessThan(1000);
    expect(sound.bundle.channels).toBe(1);
    expect(sound.bundle.peak_dbfs).toBeLessThan(0);
    expect(sound.bundle.peak_dbfs).toBeGreaterThan(-60);
    expect(sound.bundle.layers.map((l) => l.id)).toEqual(["crack", "body"]);
    expect(sound.bundle.resonances.length).toBeGreaterThan(0);
    expect(sound.bundle.loop_seam_db).toBeNull();
    expect(sound.bundle.engine_version).toMatch(/^0\.2\.0-node\d+/);
    // the modal body should ring near a palette mode
    expect(sound.bundle.resonances.some((r) => Math.abs(r.freq_hz - 180) < 40 || Math.abs(r.freq_hz - 312) < 40)).toBe(true);
    // performance target from the spec: under 500 ms for 2 s mono; 700 ms sound should be comfortably inside
    expect(elapsed).toBeLessThan(2000);
  });

  it("hits the render cache on the second call", async () => {
    const start = performance.now();
    const sound = await renderer.renderRecipeVersion("stone_impact");
    const elapsed = performance.now() - start;
    expect(sound.cached).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });

  it("renders deterministically: same recipe, byte-identical wav", async () => {
    const first = await renderer.renderRecipeVersion("stone_impact");
    const firstHash = await sha256(ws.resolve(first.file));
    // wipe the cache and re-render from scratch
    await fs.rm(ws.rendersDir, { recursive: true, force: true });
    await fs.mkdir(ws.rendersDir, { recursive: true });
    const second = await renderer.renderRecipeVersion("stone_impact");
    expect(second.cached).toBe(false);
    expect(await sha256(ws.resolve(second.file))).toBe(firstHash);
  });

  it("editing a palette entry invalidates the cache", async () => {
    const before = await renderer.renderRecipeVersion("stone_impact");
    const project = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
    project.palette.resonators.stone_large.modes[0].freq_hz = 200;
    await fs.writeFile(path.join(root, "project.json"), JSON.stringify(project, null, 2));
    const after = await renderer.renderRecipeVersion("stone_impact");
    expect(after.file).not.toBe(before.file); // different cache key
    expect(after.cached).toBe(false);
    // restore
    project.palette.resonators.stone_large.modes[0].freq_hz = 180;
    await fs.writeFile(path.join(root, "project.json"), JSON.stringify(project, null, 2));
  });

  it("variants are deterministic per index and differ between indices", async () => {
    const v1 = await renderer.renderRecipeVersion("stone_impact", undefined, 1);
    const v2 = await renderer.renderRecipeVersion("stone_impact", undefined, 2);
    expect(v1.file).not.toBe(v2.file);
    const h1 = await sha256(ws.resolve(v1.file));
    const h2 = await sha256(ws.resolve(v2.file));
    expect(h1).not.toBe(h2);
    // out-of-range variant errors clearly
    await expect(renderer.renderRecipeVersion("stone_impact", undefined, 9)).rejects.toThrow(/1\.\.5/);
  });

  it("patch_recipe semantics bump the version and change the render", async () => {
    const { recipe } = await store.read("stone_impact");
    const patched = mergePatch(recipe, { master: { gain_db: -7 } });
    const { version } = await store.write("stone_impact", patched);
    expect(version).toBe(2);
    const sound = await renderer.renderRecipeVersion("stone_impact");
    const old = await renderer.renderRecipeVersion("stone_impact", 1);
    expect(sound.bundle.peak_dbfs).toBeCloseTo(old.bundle.peak_dbfs - 3, 0);
    // history and revert
    await store.checkpoint("stone_impact", "quieter master");
    const history = await store.history("stone_impact");
    expect(history.length).toBe(2);
    expect(history[1].label).toBe("quieter master");
    const reverted = await store.revert("stone_impact", 1);
    expect(reverted.version).toBe(3);
    expect(reverted.recipe.master.gain_db).toBe(-4);
  });

  it("exports ogg with peak normalization and a manifest", async () => {
    const project = await ws.loadProject();
    const sound = await renderer.renderRecipeVersion("stone_impact");
    const entry = await exportSound(renderer, project, sound, "stone_impact", null, { format: "ogg" });
    expect(entry.file).toBe("exports/stone_impact_00.ogg");
    expect(entry.peak_db).toBeCloseTo(-1.0, 0.5); // project default peak target

    const data = await fs.readFile(ws.resolve(entry.file));
    expect(data.length).toBeGreaterThan(100);
    const decoded = await decodeAudio(new Uint8Array(data), ".ogg");
    expect(decoded.channels.length).toBe(1);
    const seconds = decoded.channels[0].length / decoded.sampleRate;
    expect(seconds).toBeGreaterThanOrEqual(0.69); // recipe duration plus reverb ring-out
    expect(seconds).toBeLessThan(1.05);
  });

  it("analyzes a refs file as-is", async () => {
    const sound = await renderer.renderRef("refs/ir_cave_small.wav");
    expect(sound.bundle.duration_ms).toBeCloseTo(200, 0);
    expect(sound.bundle.file).toBe("refs/ir_cave_small.wav");
  });

  it("generates the audition page", async () => {
    const base = await renderer.renderRecipeVersion("stone_impact");
    const v1 = await renderer.renderRecipeVersion("stone_impact", undefined, 1);
    const rel = await generateAuditionPage(renderer, [
      { name: "stone_impact", version: base.version!, base, variants: [v1] },
    ]);
    const html = await fs.readFile(ws.resolve(rel), "utf8");
    expect(html).toContain("stone_impact");
    expect(html).toContain("<audio");
    expect(html).toContain("ir_cave_small.wav"); // refs alongside for A/B
  });

  it("loop mode trims and measures the seam", async () => {
    await store.write("hum_loop", {
      name: "hum_loop",
      duration_ms: 1000,
      seed: 3,
      layers: [
        {
          id: "tone",
          source: { type: "osc", shape: "sine", freq_hz: 110 },
          gain_db: -12,
        },
      ],
      loop: { enabled: true, crossfade_ms: 100 },
    });
    const sound = await renderer.renderRecipeVersion("hum_loop");
    expect(sound.bundle.duration_ms).toBeCloseTo(900, 0);
    expect(sound.bundle.loop_seam_db).not.toBeNull();
  });

  it("lints a clipping recipe with E101", async () => {
    await store.write("too_hot", {
      name: "too_hot",
      duration_ms: 300,
      seed: 1,
      layers: [{ id: "n", source: { type: "noise", color: "white" }, gain_db: 18 }],
    });
    const sound = await renderer.renderRecipeVersion("too_hot");
    expect(sound.findings.some((f) => f.code === "E101")).toBe(true);
    expect(worstSeverity(sound.findings)).toBe("error");
  });

  it("lints a long silent tail with W202", async () => {
    await store.write("tailcase", {
      name: "tailcase",
      duration_ms: 1000,
      seed: 1,
      layers: [
        {
          id: "blip",
          source: { type: "osc", shape: "sine", freq_hz: 880 },
          envelope: { attack_ms: 1, decay_ms: 80, sustain: 0, curve: "exp" },
          gain_db: -6,
        },
      ],
    });
    const sound = await renderer.renderRecipeVersion("tailcase");
    expect(sound.findings.some((f) => f.code === "W202")).toBe(true);
  });
});
