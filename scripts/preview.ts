/** Renders a sample recipe's spectrogram + waveform PNGs for visual inspection. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Workspace } from "../src/core/workspace.js";
import { RecipeStore } from "../src/core/store.js";
import { Renderer } from "../src/core/renderer.js";
import { renderSpectrogramPng, renderWaveformPng } from "../src/analysis/spectrogram.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixdown-preview-"));
const ws = new Workspace(root);
await ws.init();
const store = new RecipeStore(ws);
const renderer = new Renderer(ws, store);

await store.write("laser_zap", {
  duration_ms: 400,
  seed: 7,
  layers: [
    {
      id: "zap",
      source: { type: "osc", shape: "saw", freq_hz: 1800, pitch_env: { end_semitones: -24, curve: "exp" } },
      filters: [{ type: "lowpass", cutoff_hz: 8000, q: 2, sweep: { end_hz: 600, curve: "exp" } }],
      envelope: { attack_ms: 2, decay_ms: 320, sustain: 0, curve: "exp" },
      gain_db: -8,
    },
  ],
});

const sound = await renderer.renderRecipeVersion("laser_zap");
const out = path.resolve("tmp-preview");
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, "spectrogram.png"), await renderSpectrogramPng(renderer.stftOf(sound), sound.bundle.duration_ms, "laser_zap"));
await fs.writeFile(path.join(out, "waveform.png"), await renderWaveformPng(sound.mix, "laser_zap"));
console.log(JSON.stringify(sound.bundle, null, 2));
await fs.rm(root, { recursive: true, force: true });
