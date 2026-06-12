/**
 * MCP server wiring: every tool returns a text block carrying a JSON payload,
 * then zero or more PNG image blocks. Validation failures surface as the
 * spec's error model so a model can repair the recipe in one step.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Workspace } from "./core/workspace.js";
import { RecipeStore, mergePatch, recipeDiff, applyLayerPatch } from "./core/store.js";
import { Renderer, RenderedSound } from "./core/renderer.js";
import { parseSoundRef } from "./core/soundref.js";
import { exportSound, ManifestEntry } from "./core/exporter.js";
import { generateAuditionPage, AuditionSound } from "./core/audition.js";
import { ValidationError, jitterSchema, validateOrThrow, collectUnknownKeys } from "./schema.js";
import { worstSeverity } from "./analysis/lint.js";
import { renderSpectrogramPng, renderWaveformPng, renderComparePng, renderVariantStripPng } from "./analysis/spectrogram.js";
import { BANDS } from "./analysis/spectral.js";
import { ENGINE_VERSION } from "./dsp/engine.js";
import { AnalysisBundle } from "./analysis/bundle.js";
import { DECODABLE_EXTENSIONS } from "./io/audio.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

function ok(payload: unknown, images: Buffer[] = []): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) },
      ...images.map((img) => ({ type: "image" as const, data: img.toString("base64"), mimeType: "image/png" })),
    ],
  };
}

function fail(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

function guard<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ValidationError) return fail(err.detail);
      return fail({ error: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * Unknown-key handling shared by write_recipe / patch_recipe / patch_layer.
 * Lenient (default): keys the schema would drop become warnings. Strict: the
 * write is refused so a typo like `filter` for `filters` can't silently lose
 * data. The pointer list comes from collectUnknownKeys (co-located with the
 * schema so it stays in sync).
 */
function checkUnknownKeys(input: unknown, strict: boolean): { warnings: string[]; error?: ReturnType<typeof fail> } {
  const unknown = collectUnknownKeys(input);
  if (strict && unknown.length > 0) {
    return {
      warnings: [],
      error: fail({
        error: "unknown_keys",
        message: `strict mode: ${unknown.length} unknown key(s) the schema would drop; fix the typo(s) or omit strict. See list_presets.recipe_skeleton for the exact shape.`,
        keys: unknown,
      }),
    };
  }
  return { warnings: unknown.map((p) => `unknown key "${p}" ignored`) };
}

/**
 * A complete, valid recipe shown by list_presets so the document shape — and
 * especially the plural container names (layers, filters, bus) that are easy to
 * mis-guess — is unambiguous on first contact. Fields not shown take defaults.
 */
const RECIPE_SKELETON = {
  name: "example_sound",
  description: "what this sound is for",
  duration_ms: 400,
  seed: 0,
  layers: [
    {
      id: "body",
      source: { type: "osc", shape: "sine", freq_hz: 220, pitch_env: { end_semitones: -12, curve: "exp" } },
      filters: [{ type: "lowpass", cutoff_hz: 2000, q: 0.7 }],
      envelope: { attack_ms: 2, decay_ms: 120, sustain: 0, release_ms: 40, curve: "exp" },
      gain_db: -6,
    },
    {
      id: "texture",
      source: { type: "sample", file: "refs/whoosh.wav", rate: 1, reverse: false, pitch_env: { end_semitones: 7, curve: "lin" } },
      gain_db: -12,
      delay_ms: 10,
    },
  ],
  bus: [{ type: "waveshaper", drive_db: 8, shape: "tanh" }],
  master: { gain_db: 0, dc_block: true },
  loop: { enabled: false },
  loudness: { mode: "none" },
  lint: { allow: [] },
};

function findingsSummary(sound: RenderedSound) {
  return sound.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message }));
}

/** Suppressed findings included only when present, to keep payloads lean. */
function suppressedSummary(sound: RenderedSound) {
  return sound.suppressed.length > 0
    ? sound.suppressed.map((f) => ({ code: f.code, severity: f.severity, message: f.message }))
    : undefined;
}

function metricDeltas(a: AnalysisBundle, b: AnalysisBundle) {
  const d = (x: number, y: number) => Math.round((y - x) * 10) / 10;
  return {
    duration_ms: d(a.duration_ms, b.duration_ms),
    peak_dbfs: d(a.peak_dbfs, b.peak_dbfs),
    true_peak_dbtp: d(a.true_peak_dbtp, b.true_peak_dbtp),
    rms_dbfs: d(a.rms_dbfs, b.rms_dbfs),
    lufs_integrated: d(a.lufs_integrated, b.lufs_integrated),
    centroid_mean_hz: Math.round(b.spectral_centroid_hz.mean - a.spectral_centroid_hz.mean),
    attack_ms: d(a.attack_ms, b.attack_ms),
  };
}

function bandDeltas(a: AnalysisBundle, b: AnalysisBundle) {
  const out: Record<string, number> = {};
  for (const [label] of BANDS) {
    out[label] = Math.round((b.band_energy_db[label] - a.band_energy_db[label]) * 10) / 10;
  }
  return out;
}

export async function createServer(wsRoot: string): Promise<{ server: McpServer; ws: Workspace }> {
  const ws = new Workspace(wsRoot);
  await ws.init();
  const store = new RecipeStore(ws);
  const renderer = new Renderer(ws, store);

  const server = new McpServer({ name: "mixdown", version: "0.3.0" });

  const soundrefDesc = 'Sound reference: name[@version][#variant] (e.g. "stone_impact", "stone_impact@3", "stone_impact#2") or a "refs/" file path.';

  server.registerTool(
    "list_sounds",
    {
      description: "List every recipe with its current version, duration, variant count, and worst lint severity.",
      inputSchema: {},
    },
    guard(async () => {
      const names = await store.listNames();
      const sounds = [];
      for (const name of names) {
        const { version, recipe } = await store.read(name);
        let severity = "unrendered";
        try {
          const rendered = await renderer.renderRecipeVersion(name);
          severity = worstSeverity(rendered.findings);
        } catch (err) {
          severity = `render failed: ${err instanceof Error ? err.message : err}`;
        }
        sounds.push({
          name,
          version,
          duration_ms: recipe.duration_ms,
          variants: recipe.variants?.count ?? 0,
          loop: recipe.loop.enabled,
          lint: severity,
          hidden: recipe.hidden || undefined,
          description: recipe.description || undefined,
        });
      }
      return ok({ sounds });
    }),
  );

  server.registerTool(
    "read_recipe",
    {
      description: "Read a recipe. Version omitted means head.",
      inputSchema: {
        name: z.string(),
        version: z.number().int().min(1).optional(),
      },
    },
    guard(async ({ name, version }) => {
      const result = await store.read(name, version);
      return ok(result);
    }),
  );

  server.registerTool(
    "write_recipe",
    {
      description:
        "Create or replace a recipe. Validates against the schema, fills defaults, bumps the version, snapshots the previous version to history. Writing a new name creates the sound. Call list_presets for accepted fields, enums, and a recipe_skeleton showing the exact shape. Unknown keys are dropped with a warning; pass strict: true to refuse the write instead.",
      inputSchema: {
        name: z.string(),
        recipe: z.record(z.string(), z.unknown()),
        strict: z.boolean().default(false).describe("refuse the write if any key would be dropped, instead of warning"),
      },
    },
    guard(async ({ name, recipe, strict }) => {
      const { warnings, error } = checkUnknownKeys(recipe, strict);
      if (error) return error;
      const { version } = await store.write(name, recipe);
      return ok({ version, warnings });
    }),
  );

  server.registerTool(
    "patch_recipe",
    {
      description:
        "RFC 7386 JSON merge patch against the head version, for small edits without resending the document. Arrays replace whole; to edit one layer use patch_layer. null deletes a key.",
      inputSchema: {
        name: z.string(),
        patch: z.record(z.string(), z.unknown()),
        strict: z.boolean().default(false).describe("refuse the write if the merged recipe has any key the schema would drop"),
      },
    },
    guard(async ({ name, patch, strict }) => {
      const { recipe } = await store.read(name);
      const merged = mergePatch(recipe, patch);
      const { warnings, error } = checkUnknownKeys(merged, strict);
      if (error) return error;
      const { version } = await store.write(name, merged);
      return ok({ version, warnings });
    }),
  );

  server.registerTool(
    "patch_layer",
    {
      description:
        "RFC 7386 merge patch against one layer of the head version, addressed by layer id — edit a single gain or filter without resending the layers array. A null patch removes the layer.",
      inputSchema: {
        name: z.string(),
        layer_id: z.string(),
        patch: z.union([z.record(z.string(), z.unknown()), z.null()]),
        strict: z.boolean().default(false).describe("refuse the write if the patched layer has any key the schema would drop"),
      },
    },
    guard(async ({ name, layer_id, patch, strict }) => {
      const { recipe } = await store.read(name);
      const merged = applyLayerPatch(recipe, layer_id, patch);
      const { warnings, error } = checkUnknownKeys(merged, strict);
      if (error) return error;
      const { version } = await store.write(name, merged);
      return ok({ version, warnings });
    }),
  );

  server.registerTool(
    "list_presets",
    {
      description:
        "Every enum and field the server accepts: source types, filter types, effect types, curve names, palette resonators and IRs, jitter fields, plus a recipe_skeleton showing the exact document shape. Call once per session instead of guessing field names.",
      inputSchema: {},
    },
    guard(async () => {
      const project = await ws.loadProject();
      return ok({
        engine_version: ENGINE_VERSION,
        soundref: "name[@version][#variant] | refs/filename",
        recipe_skeleton: RECIPE_SKELETON,
        units: "milliseconds, Hz, dB, semitones, wet 0..1, q unitless",
        curves: ["lin", "exp", "log"],
        sources: {
          noise: { color: ["white", "pink", "brown", "blue"], notes: "seeded; normalized to -12 dBFS RMS" },
          osc: {
            shape: ["sine", "triangle", "saw", "square", "pulse"],
            fields: {
              freq_hz: "1..20000",
              duty: "0.05..0.95, pulse only",
              pitch_env:
                "{ end_semitones: -48..48, curve } single sweep, or { points: [{ at: 0..1, semitones }], curve } breakpoints (e.g. rise then fall)",
            },
          },
          modal: {
            fields: {
              preset: "palette resonator name (or inline modes, not both)",
              modes: "[{ freq_hz: 20..20000, decay_ms: 1..30000 (time to -60 dB), gain_db: -60..24 }]",
              excite: ["impulse", "noise"],
              excite_ms: "0.1..1000, noise excitation length",
            },
          },
          sample: {
            fields: {
              file: "refs/ path",
              start_ms: ">=0",
              end_ms: ">=0",
              rate: "0.25..4 static playback speed (2 = up an octave and twice as fast); default 1",
              reverse: "true plays the slice backward",
              pitch_env: "same shape as osc pitch_env; deterministic pitch sweep over the layer via resampling (rise/fall, breakpoints)",
            },
          },
          granular: {
            fields: {
              file: "refs/ path",
              grain_ms: "5..1000",
              density_hz: "0.5..1000",
              position: "0..1",
              position_jitter: "0..1 half-width",
              pitch_jitter_semitones: "0..24 half-width",
            },
          },
          genai: "reserved for a future release",
        },
        filters: {
          types: ["lowpass", "highpass", "bandpass", "notch", "peak", "lowshelf", "highshelf"],
          fields: {
            cutoff_hz: "20..20000, center frequency for band types",
            q: "0.05..30, default 0.707",
            gain_db: "-40..24, peak and shelf types only",
            sweep: "{ end_hz: 20..20000, curve } interpolates cutoff across the layer",
          },
        },
        envelope: {
          fields: { attack_ms: 0, hold_ms: 0, decay_ms: 0, sustain: 1, release_ms: 0, curve: "lin" },
          notes:
            "values shown are defaults; attack/hold/decay run from layer start; sustain holds until duration_ms - release_ms; attack_curve/decay_curve/release_curve override curve per segment",
        },
        lfo: {
          fields: {
            target: ["gain", "pitch", "cutoff"],
            rate_hz: "0.05..100",
            rate_end_hz: "optional; sweeps the rate across the layer for accelerating wobble",
            depth: "gain: dB (max 24); pitch: semitones (max 24, osc sources only); cutoff: percent (max 95, needs a filter)",
            curve: "shape of the rate sweep",
          },
          notes: "per-layer sine LFO; phase starts at zero, fully deterministic",
        },
        bus_effects: {
          reverb: { ir: "palette IR name or refs/ path", wet: "0..1", predelay_ms: "0..500" },
          delay: { time_ms: "1..5000", feedback: "0..0.95", wet: "0..1" },
          eq: { bands: "[{ freq_hz, gain_db: -24..24, q }] up to 8" },
          waveshaper: { drive_db: "0..60", shape: ["tanh", "fold"] },
          compressor: { threshold_db: "-60..0", ratio: "1..20", attack_ms: "0.1..500", release_ms: "1..2000" },
        },
        jitter_fields: {
          pitch_semitones: "0..12 half-width, whole-sound pitch offset",
          gain_db: "0..12 half-width, applied at master",
          layer_delay_ms: "0..200 half-width, per layer",
          cutoff_pct: "0..50 half-width, per filter",
        },
        loop: { enabled: false, crossfade_ms: "1..5000; output is trimmed to duration_ms - crossfade_ms" },
        master: {
          gain_db: "-40..24",
          fade_in_ms: "global fade-in over the start of the output",
          fade_out_ms: "global fade-out over the end (incompatible with loop)",
          fade_curve: "lin | exp | log",
          dc_block: "default true; ~5 Hz high-pass on the master bus that removes DC from bus effects (e.g. waveshaper). Set false only if you intentionally want DC.",
        },
        loudness: {
          mode: ["peak", "lufs", "none"],
          notes:
            'normalization applied at export. "none" leaves the rendered level untouched so deliberate loud/quiet relationships between sounds survive. project.loudness is the default; a recipe may carry its own loudness block to override it for one sound (e.g. { mode: "none" }).',
          fields: { peak_db: "-24..0 (peak mode)", lufs_target: "-36..-8 or null (lufs mode)" },
        },
        recipe_fields: {
          hidden: "true excludes the sound from the audition page (working material)",
          loudness: 'optional per-recipe loudness override (same shape as project.loudness); use { mode: "none" } to opt this sound out of normalization',
          lint: '{ allow: ["W206", ...] } suppresses intentional findings; they are reported separately and do not block export',
        },
        tails: "delay and reverb ring out past duration_ms automatically; the rendered duration_ms reports the actual length (loops excluded)",
        palette: {
          resonators: Object.keys(project.palette.resonators),
          irs: Object.keys(project.palette.irs),
        },
        project: {
          sample_rate: project.sample_rate,
          channels_default: project.channels_default,
          loudness: project.loudness,
          naming: project.naming,
        },
      });
    }),
  );

  server.registerTool(
    "render",
    {
      description:
        `Render a sound (cached by content hash) and return the analysis bundle, lint findings, the wav path, and requested images. A refs/ soundref skips synthesis and analyzes the file as-is. ${soundrefDesc}`,
      inputSchema: {
        ref: z.string(),
        images: z.enum(["none", "spectrogram", "spectrogram+waveform"]).default("spectrogram"),
      },
    },
    guard(async ({ ref, images }) => {
      const sound = await renderer.render(parseSoundRef(ref));
      const imgs: Buffer[] = [];
      if (images !== "none") {
        const s = renderer.stftOf(sound);
        imgs.push(await renderSpectrogramPng(s, sound.bundle.duration_ms, ref));
        if (images === "spectrogram+waveform") imgs.push(await renderWaveformPng(sound.mix, ref));
      }
      return ok(
        {
          version: sound.version,
          variant: sound.variant,
          cached: sound.cached,
          analysis: sound.bundle,
          lint: findingsSummary(sound),
          lint_suppressed: suppressedSummary(sound),
        },
        imgs,
      );
    }),
  );

  server.registerTool(
    "compare",
    {
      description: `Compare two sounds: metric deltas (b minus a), a per-band energy delta table, and both spectrograms stacked on identical axes. ${soundrefDesc}`,
      inputSchema: {
        a: z.string(),
        b: z.string(),
      },
    },
    guard(async ({ a, b }) => {
      const soundA = await renderer.render(parseSoundRef(a));
      const soundB = await renderer.render(parseSoundRef(b));
      const img = await renderComparePng(
        { stft: renderer.stftOf(soundA), durationMs: soundA.bundle.duration_ms, title: a },
        { stft: renderer.stftOf(soundB), durationMs: soundB.bundle.duration_ms, title: b },
      );
      return ok(
        {
          a: { ref: a, analysis: soundA.bundle },
          b: { ref: b, analysis: soundB.bundle },
          delta_b_minus_a: metricDeltas(soundA.bundle, soundB.bundle),
          band_energy_delta_db: bandDeltas(soundA.bundle, soundB.bundle),
        },
        [img],
      );
    }),
  );

  server.registerTool(
    "lint",
    {
      description: `Lint findings only, no images. Uses the render cache, so it is cheap when nothing changed. ${soundrefDesc}`,
      inputSchema: { ref: z.string() },
    },
    guard(async ({ ref }) => {
      const sound = await renderer.render(parseSoundRef(ref));
      return ok({
        worst: worstSeverity(sound.findings),
        findings: findingsSummary(sound),
        suppressed: suppressedSummary(sound),
      });
    }),
  );

  server.registerTool(
    "make_variants",
    {
      description:
        "Write the variants block (count and jitter merge into the recipe, bumping the version), render all variants, and return a per-variant table plus a strip image of all variant spectrograms.",
      inputSchema: {
        name: z.string(),
        count: z.number().int().min(1).max(32).optional(),
        jitter: z.record(z.string(), z.unknown()).optional(),
      },
    },
    guard(async ({ name, count, jitter }) => {
      const read = await store.read(name);
      const recipe = read.recipe;
      const mergedJitter = validateOrThrow(jitterSchema, { ...recipe.variants?.jitter, ...jitter });
      const newCount = count ?? recipe.variants?.count ?? 0;
      if (newCount < 1) {
        return fail({ error: "failed", message: "count is required when the recipe has no variants block" });
      }
      // skip the version bump when the variants block is unchanged
      let version = read.version;
      const unchanged =
        recipe.variants?.count === newCount && JSON.stringify(recipe.variants?.jitter) === JSON.stringify(mergedJitter);
      if (!unchanged) {
        version = (await store.write(name, { ...recipe, variants: { count: newCount, jitter: mergedJitter } })).version;
      }

      const variants: RenderedSound[] = [];
      for (let n = 1; n <= newCount; n++) {
        variants.push(await renderer.renderRecipeVersion(name, undefined, n));
      }
      const table = variants.map((v) => ({
        variant: v.variant,
        file: v.file,
        peak_dbfs: v.bundle.peak_dbfs,
        centroid_hz: v.bundle.spectral_centroid_hz.mean,
        duration_ms: v.bundle.duration_ms,
        lint: worstSeverity(v.findings),
      }));
      const strip = await renderVariantStripPng(
        variants.map((v) => ({ stft: renderer.stftOf(v), durationMs: v.bundle.duration_ms, title: `${name}#${v.variant}` })),
      );
      return ok({ version, count: newCount, jitter: mergedJitter, variants: table }, [strip]);
    }),
  );

  server.registerTool(
    "freeze",
    {
      description:
        "Render a sound (cached) and copy the result into refs/ so other recipes can use it as a sample, granular, or IR source. Useful for bouncing intermediate material. " + soundrefDesc,
      inputSchema: {
        ref: z.string(),
        name: z.string().optional().describe("target filename stem inside refs/; defaults to the sound name"),
      },
    },
    guard(async ({ ref, name }) => {
      const parsed = parseSoundRef(ref);
      const sound = await renderer.render(parsed);
      const stem = (name ?? (parsed.kind === "recipe" ? parsed.name : path.basename(parsed.file, path.extname(parsed.file)))).replace(
        /[^a-zA-Z0-9_-]/g,
        "_",
      );
      const relTarget = `refs/${stem}.wav`;
      const data = await fs.readFile(ws.resolve(sound.file));
      await fs.writeFile(ws.resolve(relTarget), data);
      return ok({ file: relTarget, duration_ms: sound.bundle.duration_ms, source: ref });
    }),
  );

  server.registerTool(
    "import_reference",
    {
      description:
        "Copy an audio file (wav, ogg, flac) from an absolute local path into refs/ and return its analysis bundle. The only tool that reads outside the workspace.",
      inputSchema: {
        path: z.string().describe("absolute path to a wav, ogg, or flac file"),
        name: z.string().optional().describe("target filename inside refs/; defaults to the source filename"),
      },
    },
    guard(async ({ path: srcPath, name }) => {
      if (!path.isAbsolute(srcPath)) {
        return fail({ error: "failed", message: `path must be absolute, got "${srcPath}"` });
      }
      const ext = path.extname(srcPath).toLowerCase();
      if (!DECODABLE_EXTENSIONS.includes(ext)) {
        return fail({ error: "failed", message: `unsupported extension "${ext}"; supported: ${DECODABLE_EXTENSIONS.join(", ")}` });
      }
      const baseName = (name ?? path.basename(srcPath, ext)).replace(/[^a-zA-Z0-9_-]/g, "_");
      const relTarget = `refs/${baseName}${ext}`;
      const data = await fs.readFile(srcPath);
      await fs.writeFile(ws.resolve(relTarget), data);
      const sound = await renderer.renderRef(relTarget);
      return ok({ file: relTarget, analysis: sound.bundle, lint: findingsSummary(sound) });
    }),
  );

  server.registerTool(
    "audition_page",
    {
      description:
        "Regenerate audition/index.html covering the given names (or everything when omitted): play buttons for each sound and variant, refs alongside for A/B listening, lint badges, version labels. Returns the path for the human to open.",
      inputSchema: {
        names: z.array(z.string()).optional(),
      },
    },
    guard(async ({ names }) => {
      let targets = names;
      if (!targets) {
        // hidden recipes (working material) are excluded unless named explicitly
        const all = await store.listNames();
        targets = [];
        for (const name of all) {
          const { recipe } = await store.read(name);
          if (!recipe.hidden) targets.push(name);
        }
      }
      const sounds: AuditionSound[] = [];
      for (const name of targets) {
        const base = await renderer.renderRecipeVersion(name);
        const count = base.recipe?.variants?.count ?? 0;
        const variants: RenderedSound[] = [];
        for (let n = 1; n <= count; n++) variants.push(await renderer.renderRecipeVersion(name, undefined, n));
        sounds.push({ name, version: base.version!, base, variants });
      }
      const rel = await generateAuditionPage(renderer, sounds);
      return ok({
        path: rel,
        absolute_path: ws.resolve(rel),
        sounds: sounds.length,
        variants: sounds.reduce((acc, s) => acc + s.variants.length, 0),
      });
    }),
  );

  server.registerTool(
    "export",
    {
      description:
        "Export game-ready files. Applies project loudness and naming ({nn}: base sound is 00, variants are 01..count). Refuses if any error-severity lint finding exists, unless force is true. Defaults: project channels, project sample rate, ogg vorbis.",
      inputSchema: {
        names: z.array(z.string()).min(1),
        include_variants: z.boolean().default(false),
        format: z.enum(["ogg", "wav"]).default("ogg"),
        channels: z.enum(["mono", "stereo"]).optional(),
        sample_rate: z.number().int().min(8000).max(96000).optional(),
        force: z.boolean().default(false),
      },
    },
    guard(async ({ names, include_variants, format, channels, sample_rate, force }) => {
      const project = await ws.loadProject();
      const jobs: { sound: RenderedSound; name: string; variant: number | null }[] = [];
      for (const name of names) {
        const base = await renderer.renderRecipeVersion(name);
        jobs.push({ sound: base, name, variant: null });
        if (include_variants) {
          const count = base.recipe?.variants?.count ?? 0;
          for (let n = 1; n <= count; n++) {
            jobs.push({ sound: await renderer.renderRecipeVersion(name, undefined, n), name, variant: n });
          }
        }
      }

      const exportToMono = (channels ?? project.channels_default) === "mono";
      const blocking: { source: string; code: string; message: string }[] = [];
      for (const job of jobs) {
        for (const f of job.sound.findings) {
          if (f.severity === "error") {
            blocking.push({ source: job.variant === null ? job.name : `${job.name}#${job.variant}`, code: f.code, message: f.message });
          }
        }
      }
      if (blocking.length > 0 && !force) {
        return fail({
          error: "lint_errors",
          message: "export refused: error-severity lint findings exist; fix them or pass force: true",
          findings: blocking,
        });
      }

      const manifest: ManifestEntry[] = [];
      const warnings: string[] = [];
      for (const job of jobs) {
        const recipeStereo = (job.sound.recipe?.channels ?? project.channels_default) === "stereo";
        if (recipeStereo && exportToMono) {
          warnings.push(`W204 ${job.name}: stereo recipe exported to a mono target; channels summed`);
        }
        manifest.push(await exportSound(renderer, project, job.sound, job.name, job.variant, { format, channels, sample_rate }));
      }
      return ok({ manifest, warnings, forced: blocking.length > 0 ? true : undefined });
    }),
  );

  server.registerTool(
    "history",
    {
      description: "List versions of a sound with timestamps and labels.",
      inputSchema: { name: z.string() },
    },
    guard(async ({ name }) => ok({ versions: await store.history(name) })),
  );

  server.registerTool(
    "checkpoint",
    {
      description: "Label the head version of a sound.",
      inputSchema: { name: z.string(), label: z.string().min(1).max(200) },
    },
    guard(async ({ name, label }) => {
      const version = await store.checkpoint(name, label);
      return ok({ version, label });
    }),
  );

  server.registerTool(
    "revert",
    {
      description: "Write an old version of a recipe as the new head.",
      inputSchema: { name: z.string(), version: z.number().int().min(1) },
    },
    guard(async ({ name, version }) => {
      const result = await store.revert(name, version);
      return ok({ version: result.version, reverted_from: version });
    }),
  );

  server.registerTool(
    "diff",
    {
      description:
        "Recipe field diff between two versions (to omitted means head), plus metric deltas when both versions are already in the render cache.",
      inputSchema: {
        name: z.string(),
        from: z.number().int().min(1),
        to: z.number().int().min(1).optional(),
      },
    },
    guard(async ({ name, from, to }) => {
      const a = await store.read(name, from);
      const b = await store.read(name, to);
      const fields = recipeDiff(a.recipe, b.recipe);
      const bundleA = await renderer.cachedBundle(name, a.version);
      const bundleB = await renderer.cachedBundle(name, b.version);
      return ok({
        from: a.version,
        to: b.version,
        fields,
        metric_deltas: bundleA && bundleB ? metricDeltas(bundleA, bundleB) : null,
        band_energy_delta_db: bundleA && bundleB ? bandDeltas(bundleA, bundleB) : null,
      });
    }),
  );

  return { server, ws };
}
