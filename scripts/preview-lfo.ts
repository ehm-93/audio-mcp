/** Visual proof of the v0.2 LFO: one layer, accelerating tremolo 3 -> 24 Hz. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Workspace } from "../src/core/workspace.js";
import { RecipeStore } from "../src/core/store.js";
import { Renderer } from "../src/core/renderer.js";
import { renderWaveformPng } from "../src/analysis/spectrogram.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixdown-lfo-"));
const ws = new Workspace(root);
await ws.init();
const renderer = new Renderer(ws, new RecipeStore(ws));
const store = new RecipeStore(ws);

await store.write("wobble_demo", {
  duration_ms: 2000,
  seed: 9,
  layers: [
    {
      id: "churn",
      source: { type: "noise", color: "white" },
      filters: [{ type: "bandpass", cutoff_hz: 1400, q: 1.5, sweep: { end_hz: 3200, curve: "log" } }],
      envelope: { attack_ms: 600, decay_ms: 0, sustain: 1, release_ms: 60, curve: "lin" },
      lfo: { target: "gain", rate_hz: 3, rate_end_hz: 24, depth: 10, curve: "lin" },
      gain_db: -4,
    },
  ],
  master: { gain_db: 0, fade_in_ms: 200 },
});

const sound = await renderer.renderRecipeVersion("wobble_demo");
const out = path.resolve("tmp-preview");
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, "lfo-wobble.png"), await renderWaveformPng(sound.mix, "one-layer accelerating wobble (LFO 3->24 Hz)"));
console.log(`lint: ${sound.findings.map((f) => f.code).join(", ") || "clean"}`);
await fs.rm(root, { recursive: true, force: true });
