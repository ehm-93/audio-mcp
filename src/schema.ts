/**
 * Zod schemas for recipes and project.json. Parsing fills defaults; the
 * validation error model (JSON pointer + constraint + offending value) is
 * produced by validateOrThrow below.
 */

import { z } from "zod";

export const curveSchema = z.enum(["lin", "exp", "log"]);

// --- sources ---

export const noiseSourceSchema = z.object({
  type: z.literal("noise"),
  color: z.enum(["white", "pink", "brown", "blue"]).default("white"),
});

export const pitchEnvSchema = z
  .object({
    end_semitones: z.number().min(-48).max(48).optional(),
    points: z
      .array(z.object({ at: z.number().min(0).max(1), semitones: z.number().min(-48).max(48) }))
      .min(2)
      .max(16)
      .optional(),
    curve: curveSchema.default("lin"),
  })
  .superRefine((pe, ctx) => {
    if ((pe.end_semitones === undefined) === (pe.points === undefined)) {
      ctx.addIssue({ code: "custom", message: "provide exactly one of end_semitones or points" });
    }
    if (pe.points) {
      for (let i = 1; i < pe.points.length; i++) {
        if (pe.points[i].at <= pe.points[i - 1].at) {
          ctx.addIssue({ code: "custom", path: ["points", i, "at"], message: "points must be sorted by ascending at" });
        }
      }
    }
  });

export const lfoSchema = z.object({
  target: z.enum(["gain", "pitch", "cutoff"]),
  rate_hz: z.number().min(0.05).max(100),
  rate_end_hz: z.number().min(0.05).max(100).optional(),
  depth: z.number().min(0),
  curve: curveSchema.default("lin"),
});

export const oscSourceSchema = z.object({
  type: z.literal("osc"),
  shape: z.enum(["sine", "triangle", "saw", "square", "pulse"]),
  freq_hz: z.number().min(1).max(20000),
  duty: z.number().min(0.05).max(0.95).default(0.5),
  pitch_env: pitchEnvSchema.optional(),
});

export const modeSchema = z.object({
  freq_hz: z.number().min(20).max(20000),
  decay_ms: z.number().min(1).max(30000),
  gain_db: z.number().min(-60).max(24).default(0),
});

export const modalSourceSchema = z.object({
  type: z.literal("modal"),
  preset: z.string().optional(),
  modes: z.array(modeSchema).min(1).optional(),
  excite: z.enum(["impulse", "noise"]).default("impulse"),
  excite_ms: z.number().min(0.1).max(1000).default(5),
});

export const sampleSourceSchema = z.object({
  type: z.literal("sample"),
  file: z.string().regex(/^refs\//, "must be a refs/ path"),
  start_ms: z.number().min(0).optional(),
  end_ms: z.number().min(0).optional(),
  rate: z.number().min(0.25).max(4).default(1),
  reverse: z.boolean().default(false),
  pitch_env: pitchEnvSchema.optional(),
});

export const granularSourceSchema = z.object({
  type: z.literal("granular"),
  file: z.string().regex(/^refs\//, "must be a refs/ path"),
  grain_ms: z.number().min(5).max(1000).default(80),
  density_hz: z.number().min(0.5).max(1000).default(20),
  position: z.number().min(0).max(1).default(0.5),
  position_jitter: z.number().min(0).max(1).default(0.1),
  pitch_jitter_semitones: z.number().min(0).max(24).default(0),
});

export const sourceSchema = z.discriminatedUnion("type", [
  noiseSourceSchema,
  oscSourceSchema,
  modalSourceSchema,
  sampleSourceSchema,
  granularSourceSchema,
]);

// --- filters ---

export const filterTypeSchema = z.enum(["lowpass", "highpass", "bandpass", "notch", "peak", "lowshelf", "highshelf"]);

export const filterSchema = z.object({
  type: filterTypeSchema,
  cutoff_hz: z.number().min(20).max(20000),
  q: z.number().min(0.05).max(30).default(0.707),
  gain_db: z.number().min(-40).max(24).default(0),
  sweep: z
    .object({
      end_hz: z.number().min(20).max(20000),
      curve: curveSchema.default("lin"),
    })
    .optional(),
});

// --- envelope ---

export const envelopeSchema = z.object({
  attack_ms: z.number().min(0).max(30000).default(0),
  hold_ms: z.number().min(0).max(30000).default(0),
  decay_ms: z.number().min(0).max(30000).default(0),
  sustain: z.number().min(0).max(1).default(1),
  release_ms: z.number().min(0).max(30000).default(0),
  curve: curveSchema.default("lin"),
  attack_curve: curveSchema.optional(),
  decay_curve: curveSchema.optional(),
  release_curve: curveSchema.optional(),
});

// --- layers ---

export const layerSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  source: sourceSchema,
  filters: z.array(filterSchema).max(8).default([]),
  envelope: envelopeSchema.prefault({}),
  lfo: lfoSchema.optional(),
  gain_db: z.number().min(-80).max(24).default(0),
  delay_ms: z.number().min(0).max(30000).default(0),
});

// --- bus effects ---

export const reverbSchema = z.object({
  type: z.literal("reverb"),
  ir: z.string(),
  wet: z.number().min(0).max(1).default(0.3),
  predelay_ms: z.number().min(0).max(500).default(0),
});

export const delaySchema = z.object({
  type: z.literal("delay"),
  time_ms: z.number().min(1).max(5000),
  feedback: z.number().min(0).max(0.95).default(0.3),
  wet: z.number().min(0).max(1).default(0.3),
});

export const eqSchema = z.object({
  type: z.literal("eq"),
  bands: z
    .array(
      z.object({
        freq_hz: z.number().min(20).max(20000),
        gain_db: z.number().min(-24).max(24),
        q: z.number().min(0.05).max(30).default(1),
      }),
    )
    .min(1)
    .max(8),
});

export const waveshaperSchema = z.object({
  type: z.literal("waveshaper"),
  drive_db: z.number().min(0).max(60).default(12),
  shape: z.enum(["tanh", "fold"]).default("tanh"),
});

export const compressorSchema = z.object({
  type: z.literal("compressor"),
  threshold_db: z.number().min(-60).max(0).default(-18),
  ratio: z.number().min(1).max(20).default(4),
  attack_ms: z.number().min(0.1).max(500).default(5),
  release_ms: z.number().min(1).max(2000).default(100),
});

export const effectSchema = z.discriminatedUnion("type", [
  reverbSchema,
  delaySchema,
  eqSchema,
  waveshaperSchema,
  compressorSchema,
]);

// --- variants / loop / recipe ---

export const jitterSchema = z.object({
  pitch_semitones: z.number().min(0).max(12).default(0),
  gain_db: z.number().min(0).max(12).default(0),
  layer_delay_ms: z.number().min(0).max(200).default(0),
  cutoff_pct: z.number().min(0).max(50).default(0),
});

export const variantsSchema = z.object({
  count: z.number().int().min(0).max(32).default(0),
  jitter: jitterSchema.prefault({}),
});

export const loopSchema = z.object({
  enabled: z.boolean().default(false),
  crossfade_ms: z.number().min(1).max(5000).default(50),
});

export const masterSchema = z.object({
  gain_db: z.number().min(-40).max(24).default(0),
  fade_in_ms: z.number().min(0).max(30000).default(0),
  fade_out_ms: z.number().min(0).max(30000).default(0),
  fade_curve: curveSchema.default("lin"),
  // one-pole ~5 Hz high-pass on the master bus; removes DC that originates
  // downstream of any layer filter (e.g. a bus waveshaper). On by default.
  dc_block: z.boolean().default(true),
});

const LFO_DEPTH_LIMITS: Record<string, [number, string]> = {
  gain: [24, "dB"],
  pitch: [24, "semitones"],
  cutoff: [95, "percent"],
};

// Loudness normalization, applied at export. "none" leaves the rendered level
// untouched so deliberate loud/quiet relationships between sounds survive. A
// recipe may carry its own loudness block to override the project default.
export const loudnessSchema = z.object({
  mode: z.enum(["peak", "lufs", "none"]).default("peak"),
  peak_db: z.number().min(-24).max(0).default(-1),
  lufs_target: z.number().min(-36).max(-8).nullable().default(null),
});

export const recipeSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    description: z.string().max(2000).default(""),
    duration_ms: z.number().min(10).max(30000),
    channels: z.enum(["mono", "stereo"]).optional(),
    seed: z.number().int().default(0),
    hidden: z.boolean().default(false),
    layers: z.array(layerSchema).min(1).max(16),
    bus: z.array(effectSchema).max(8).default([]),
    master: masterSchema.prefault({}),
    loop: loopSchema.prefault({}),
    variants: variantsSchema.optional(),
    // per-recipe loudness override; when present it replaces the project loudness
    // for this sound only (use mode "none" to opt this sound out of normalization)
    loudness: loudnessSchema.optional(),
    lint: z.object({ allow: z.array(z.string().regex(/^[EW]\d{3}$/)).max(16).default([]) }).prefault({}),
  })
  .superRefine((recipe, ctx) => {
    const ids = new Set<string>();
    recipe.layers.forEach((layer, i) => {
      if (ids.has(layer.id)) {
        ctx.addIssue({ code: "custom", path: ["layers", i, "id"], message: `duplicate layer id "${layer.id}"` });
      }
      ids.add(layer.id);
      const src = layer.source;
      if (src.type === "modal") {
        if (!src.preset && !src.modes) {
          ctx.addIssue({ code: "custom", path: ["layers", i, "source"], message: "modal source requires preset or modes" });
        }
        if (src.preset && src.modes) {
          ctx.addIssue({ code: "custom", path: ["layers", i, "source"], message: "provide preset or modes, not both" });
        }
      }
      if (layer.delay_ms >= recipe.duration_ms) {
        ctx.addIssue({ code: "custom", path: ["layers", i, "delay_ms"], message: "layer delay_ms must be less than duration_ms" });
      }
      if (layer.lfo) {
        const [maxDepth, unit] = LFO_DEPTH_LIMITS[layer.lfo.target];
        if (layer.lfo.depth > maxDepth) {
          ctx.addIssue({ code: "custom", path: ["layers", i, "lfo", "depth"], message: `${layer.lfo.target} LFO depth is in ${unit}, max ${maxDepth}` });
        }
        if (layer.lfo.target === "pitch" && src.type !== "osc") {
          ctx.addIssue({ code: "custom", path: ["layers", i, "lfo"], message: "pitch LFO requires an osc source; use gain or cutoff for noise-based layers" });
        }
        if (layer.lfo.target === "cutoff" && layer.filters.length === 0) {
          ctx.addIssue({ code: "custom", path: ["layers", i, "lfo"], message: "cutoff LFO requires at least one filter on the layer" });
        }
      }
    });
    if (recipe.loop.enabled && recipe.loop.crossfade_ms >= recipe.duration_ms / 2) {
      ctx.addIssue({ code: "custom", path: ["loop", "crossfade_ms"], message: "crossfade_ms must be under half of duration_ms" });
    }
    if (recipe.loop.enabled && (recipe.master.fade_in_ms > 0 || recipe.master.fade_out_ms > 0)) {
      ctx.addIssue({ code: "custom", path: ["master"], message: "master fades cannot be combined with loop; they would break the seam" });
    }
  });

// --- project.json ---

export const projectSchema = z.object({
  sample_rate: z.number().int().min(8000).max(96000).default(44100),
  channels_default: z.enum(["mono", "stereo"]).default("mono"),
  loudness: loudnessSchema.prefault({}),
  naming: z.string().default("{name}_{nn}"),
  seed: z.number().int().default(0),
  palette: z
    .object({
      resonators: z.record(z.string(), z.object({ modes: z.array(modeSchema).min(1) })).default({}),
      irs: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
});

export type Recipe = z.infer<typeof recipeSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Filter = z.infer<typeof filterSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Jitter = z.infer<typeof jitterSchema>;
export type Mode = z.infer<typeof modeSchema>;
export type PitchEnv = z.infer<typeof pitchEnvSchema>;
export type Lfo = z.infer<typeof lfoSchema>;
export type Loudness = z.infer<typeof loudnessSchema>;

// --- unknown-key detection ---
//
// The recipe schema strips unknown keys (Zod default), so a typo like `filter`
// for `filters` silently drops the value. This walks the raw input and reports
// every key the schema would ignore, by JSON pointer. Keep these sets in sync
// with the object schemas above; they are co-located for exactly that reason.
// write_recipe surfaces the list as warnings, or as a hard error in strict mode.

const RECIPE_KEYS = ["name", "description", "duration_ms", "channels", "seed", "hidden", "layers", "bus", "master", "loop", "variants", "loudness", "lint"];
const LAYER_KEYS = ["id", "source", "filters", "envelope", "lfo", "gain_db", "delay_ms"];
const SOURCE_KEYS: Record<string, string[]> = {
  noise: ["type", "color"],
  osc: ["type", "shape", "freq_hz", "duty", "pitch_env"],
  modal: ["type", "preset", "modes", "excite", "excite_ms"],
  sample: ["type", "file", "start_ms", "end_ms", "rate", "reverse", "pitch_env"],
  granular: ["type", "file", "grain_ms", "density_hz", "position", "position_jitter", "pitch_jitter_semitones"],
};
const FILTER_KEYS = ["type", "cutoff_hz", "q", "gain_db", "sweep"];
const EFFECT_KEYS: Record<string, string[]> = {
  reverb: ["type", "ir", "wet", "predelay_ms"],
  delay: ["type", "time_ms", "feedback", "wet"],
  eq: ["type", "bands"],
  waveshaper: ["type", "drive_db", "shape"],
  compressor: ["type", "threshold_db", "ratio", "attack_ms", "release_ms"],
};
const ENVELOPE_KEYS = ["attack_ms", "hold_ms", "decay_ms", "sustain", "release_ms", "curve", "attack_curve", "decay_curve", "release_curve"];
const LFO_KEYS = ["target", "rate_hz", "rate_end_hz", "depth", "curve"];
const MASTER_KEYS = ["gain_db", "fade_in_ms", "fade_out_ms", "fade_curve", "dc_block"];
const LOOP_KEYS = ["enabled", "crossfade_ms"];
const VARIANTS_KEYS = ["count", "jitter"];
const LOUDNESS_KEYS = ["mode", "peak_db", "lufs_target"];

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Report unknown keys (by JSON pointer) the recipe schema would silently drop. */
export function collectUnknownKeys(input: unknown): string[] {
  const out: string[] = [];
  const check = (obj: unknown, allowed: string[], prefix: string) => {
    if (!isObj(obj)) return;
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) out.push(`${prefix}/${key}`);
    }
  };
  if (!isObj(input)) return out;
  check(input, RECIPE_KEYS, "");

  const layers = input.layers;
  if (Array.isArray(layers)) {
    layers.forEach((layer, i) => {
      const lp = `/layers/${i}`;
      check(layer, LAYER_KEYS, lp);
      if (isObj(layer)) {
        const src = layer.source;
        if (isObj(src) && typeof src.type === "string" && SOURCE_KEYS[src.type]) {
          check(src, SOURCE_KEYS[src.type], `${lp}/source`);
        }
        if (Array.isArray(layer.filters)) {
          layer.filters.forEach((f, fi) => check(f, FILTER_KEYS, `${lp}/filters/${fi}`));
        }
        check(layer.envelope, ENVELOPE_KEYS, `${lp}/envelope`);
        check(layer.lfo, LFO_KEYS, `${lp}/lfo`);
      }
    });
  }

  const bus = input.bus;
  if (Array.isArray(bus)) {
    bus.forEach((fx, i) => {
      if (isObj(fx) && typeof fx.type === "string" && EFFECT_KEYS[fx.type]) {
        check(fx, EFFECT_KEYS[fx.type], `/bus/${i}`);
      }
    });
  }

  check(input.master, MASTER_KEYS, "/master");
  check(input.loop, LOOP_KEYS, "/loop");
  check(input.variants, VARIANTS_KEYS, "/variants");
  check(input.loudness, LOUDNESS_KEYS, "/loudness");
  return out;
}

// --- validation error model ---

export class ValidationError extends Error {
  constructor(
    public detail: { error: "validation"; path: string; message: string; got: unknown },
  ) {
    super(detail.message);
  }
}

function dig(obj: unknown, path: (string | number | symbol)[]): unknown {
  let cur: any = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key as any];
  }
  return cur;
}

/** Parse with the given schema; on failure throw a ValidationError naming the JSON pointer and offending value. */
export function validateOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const pointer = "/" + issue.path.map(String).join("/");
  throw new ValidationError({
    error: "validation",
    path: pointer === "/" ? "" : pointer,
    message: issue.message,
    got: dig(input, issue.path),
  });
}
