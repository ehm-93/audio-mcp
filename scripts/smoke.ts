/**
 * Protocol-level smoke test: spawns the built server over stdio and walks a
 * realistic session: list_presets, write_recipe, render (expect a PNG block),
 * make_variants, compare, lint, audition_page, export, history/diff.
 *
 * Usage: node --import tsx scripts/smoke.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixdown-smoke-"));
console.log(`workspace: ${root}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js"), root],
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;

function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}`, detail ?? "");
  }
}

function firstJson(result: any): any {
  const text = result.content.find((c: any) => c.type === "text");
  return text ? JSON.parse(text.text) : null;
}

function pngCount(result: any): number {
  return result.content.filter((c: any) => c.type === "image" && c.mimeType === "image/png").length;
}

const tools = await client.listTools();
console.log(`tools: ${tools.tools.length}`);
check("18 tools registered", tools.tools.length === 18, tools.tools.map((t) => t.name));

const presets = firstJson(await client.callTool({ name: "list_presets", arguments: {} }));
check("list_presets has source enums", presets.sources?.osc?.shape?.includes("saw"));

const laser = {
  description: "retro laser zap",
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
  variants: { count: 3, jitter: { pitch_semitones: 1.0, gain_db: 0.8 } },
};

const wrote = firstJson(await client.callTool({ name: "write_recipe", arguments: { name: "laser_zap", recipe: laser } }));
check("write_recipe returns version 1", wrote.version === 1, wrote);

// validation error model
const bad = await client.callTool({
  name: "write_recipe",
  arguments: { name: "bad", recipe: { ...laser, duration_ms: 999999 } },
});
const badJson = firstJson(bad);
check("validation error names pointer + value", bad.isError === true && badJson.path === "/duration_ms" && badJson.got === 999999, badJson);

const rendered: any = await client.callTool({ name: "render", arguments: { ref: "laser_zap", images: "spectrogram+waveform" } });
const renderJson = firstJson(rendered);
check("render returns analysis bundle", typeof renderJson.analysis?.peak_dbfs === "number", renderJson);
check("render returns 2 PNGs", pngCount(rendered) === 2);
check("render reports band energies", Object.keys(renderJson.analysis.band_energy_db).length === 8);

const rendered2 = firstJson(await client.callTool({ name: "render", arguments: { ref: "laser_zap", images: "none" } }));
check("second render is cached", rendered2.cached === true);

const variants: any = await client.callTool({ name: "make_variants", arguments: { name: "laser_zap", count: 4 } });
const variantsJson = firstJson(variants);
check("make_variants table has 4 rows", variantsJson.variants?.length === 4, variantsJson);
check("make_variants returns strip image", pngCount(variants) === 1);

const compared: any = await client.callTool({ name: "compare", arguments: { a: "laser_zap", b: "laser_zap#2" } });
const comparedJson = firstJson(compared);
check("compare returns deltas + stacked image", comparedJson.delta_b_minus_a !== undefined && pngCount(compared) === 1);

const linted = firstJson(await client.callTool({ name: "lint", arguments: { ref: "laser_zap" } }));
check("lint returns findings", Array.isArray(linted.findings));

const audition = firstJson(await client.callTool({ name: "audition_page", arguments: {} }));
check("audition page written", audition.path === "audition/index.html");
check("audition file exists", await fs.access(path.join(root, "audition", "index.html")).then(() => true, () => false));

const exported = firstJson(await client.callTool({ name: "export", arguments: { names: ["laser_zap"], include_variants: true } }));
check("export manifest has base + 4 variants", exported.manifest?.length === 5, exported);
check("export applied peak target", Math.abs(exported.manifest[0].peak_db - -1.0) < 0.5, exported.manifest?.[0]);

const patched = firstJson(await client.callTool({ name: "patch_recipe", arguments: { name: "laser_zap", patch: { master: { gain_db: -2 } } } }));
check("patch bumps version", patched.version === 3, patched); // make_variants already bumped to 2

const layerPatched = firstJson(
  await client.callTool({ name: "patch_layer", arguments: { name: "laser_zap", layer_id: "zap", patch: { gain_db: -10 } } }),
);
check("patch_layer bumps version", layerPatched.version === 4, layerPatched);
const afterLayerPatch = firstJson(await client.callTool({ name: "read_recipe", arguments: { name: "laser_zap" } }));
check("patch_layer changed only the layer gain", afterLayerPatch.recipe?.layers?.[0]?.gain_db === -10, afterLayerPatch.recipe?.layers?.[0]);

const frozen = firstJson(await client.callTool({ name: "freeze", arguments: { ref: "laser_zap" } }));
check("freeze writes into refs/", frozen.file === "refs/laser_zap.wav", frozen);

const hist = firstJson(await client.callTool({ name: "history", arguments: { name: "laser_zap" } }));
check("history lists 4 versions", hist.versions?.length === 4, hist);

const diffed = firstJson(await client.callTool({ name: "diff", arguments: { name: "laser_zap", from: 2, to: 3 } }));
check("diff shows master gain change", diffed.fields?.some((f: any) => f.path === "/master/gain_db"), diffed.fields);

const sounds = firstJson(await client.callTool({ name: "list_sounds", arguments: {} }));
check("list_sounds shows laser_zap with variants", sounds.sounds?.some((s: any) => s.name === "laser_zap" && s.variants === 4), sounds);

await client.close();
await fs.rm(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
