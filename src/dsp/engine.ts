/**
 * Render pipeline: recipe -> audio. Signal flow per layer is source, pitch
 * shift, filters in order, envelope, LFO (gain target), gain_db, then offset
 * by delay_ms and summed. The sum passes through bus effects in order, then
 * master gain, then either the loop crossfade or tail ring-out plus master
 * fades.
 *
 * Tail ring-out: delay and reverb keep sounding past duration_ms, so the
 * render buffer is extended by the effects' decay time and trailing samples
 * below -66 dBFS are trimmed afterwards. duration_ms is always preserved;
 * only the extension is trimmed. Loops skip the extension entirely.
 *
 * Determinism: layer randomness seeds from hash(recipe.seed, layer.id) so
 * editing one layer never reshuffles another; variant n draws its jitter
 * from hash(recipe.seed, "variant", n) in a fixed order (pitch, gain, then
 * per-layer delays, then per-filter cutoffs in document order). LFO phases
 * start at zero.
 */

import { Recipe, Layer, Project, Mode, Lfo } from "../schema.js";
import { AudioBuf, createBuf, matchChannels, dbToLin, mixInto, bufLength } from "./buffer.js";
import { hashSeed, mulberry32 } from "./prng.js";
import { renderNoise } from "./noise.js";
import { renderOsc, makeLfo, pitchEnvSemitones } from "./osc.js";
import { renderModal } from "./modal.js";
import { renderGranular } from "./granular.js";
import { pitchShift, varispeed } from "./resample.js";
import { applyFilter, curveInterp } from "./biquad.js";
import { applyEnvelope } from "./envelope.js";
import { applyReverb, applyDelay, applyEq, applyWaveshaper, applyCompressor } from "./effects.js";
import { applyLoopCrossfade } from "./loop.js";

export const ENGINE_VERSION = `0.3.0-node${process.versions.node.split(".")[0]}`;

const TAIL_TRIM_THRESHOLD = Math.pow(10, -66 / 20);
const TAIL_CAP_SECONDS = 8;

export interface EngineContext {
  project: Project;
  /** Load a refs/ audio file, already resampled to the project rate. */
  loadRef: (file: string) => Promise<AudioBuf>;
}

export interface RenderResult {
  mix: AudioBuf;
  /** Per-layer contribution aligned to the mix timeline, pre-bus, post-gain. */
  layers: { id: string; buf: AudioBuf }[];
}

interface VariantJitter {
  pitchSemitones: number;
  gainDb: number;
  layerDelayMs: Map<string, number>;
  cutoffMul: Map<string, number[]>; // layer id -> per-filter multiplier
}

function drawVariantJitter(recipe: Recipe, variantIndex: number): VariantJitter {
  const jitter = recipe.variants?.jitter;
  const rand = mulberry32(hashSeed(recipe.seed, "variant", variantIndex));
  const u = () => rand() * 2 - 1;
  const j: VariantJitter = {
    pitchSemitones: u() * (jitter?.pitch_semitones ?? 0),
    gainDb: u() * (jitter?.gain_db ?? 0),
    layerDelayMs: new Map(),
    cutoffMul: new Map(),
  };
  for (const layer of recipe.layers) {
    j.layerDelayMs.set(layer.id, u() * (jitter?.layer_delay_ms ?? 0));
    j.cutoffMul.set(
      layer.id,
      layer.filters.map(() => 1 + (u() * (jitter?.cutoff_pct ?? 0)) / 100),
    );
  }
  return j;
}

async function renderSource(
  layer: Layer,
  lengthSamples: number,
  sampleRate: number,
  numChannels: number,
  seed: number,
  ctx: EngineContext,
): Promise<AudioBuf> {
  const src = layer.source;
  switch (src.type) {
    case "noise": {
      const mono = renderNoise(lengthSamples, src.color, seed);
      return matchChannels({ sampleRate, channels: [mono] }, numChannels);
    }
    case "osc": {
      const pitchLfo = layer.lfo?.target === "pitch" ? layer.lfo : undefined;
      const mono = renderOsc(lengthSamples, sampleRate, src.shape, src.freq_hz, src.duty, src.pitch_env, pitchLfo);
      return matchChannels({ sampleRate, channels: [mono] }, numChannels);
    }
    case "modal": {
      let modes: Mode[];
      if (src.preset) {
        const preset = ctx.project.palette.resonators[src.preset];
        if (!preset) {
          throw new Error(
            `unknown resonator preset "${src.preset}"; palette has: ${Object.keys(ctx.project.palette.resonators).join(", ") || "(none)"}`,
          );
        }
        modes = preset.modes;
      } else {
        modes = src.modes!;
      }
      const mono = renderModal(lengthSamples, sampleRate, modes, src.excite, src.excite_ms, seed);
      return matchChannels({ sampleRate, channels: [mono] }, numChannels);
    }
    case "sample": {
      const file = await ctx.loadRef(src.file);
      const startI = Math.round(((src.start_ms ?? 0) / 1000) * sampleRate);
      const endI = src.end_ms != null ? Math.round((src.end_ms / 1000) * sampleRate) : file.channels[0].length;
      const sliced: AudioBuf = {
        sampleRate,
        channels: file.channels.map((ch) => {
          const cut = ch.slice(Math.min(startI, ch.length), Math.min(endI, ch.length));
          if (src.reverse) cut.reverse();
          return cut;
        }),
      };
      const matched = matchChannels(sliced, numChannels);
      const pitched = src.rate !== 1 || src.pitch_env !== undefined;
      const semitonesAt = src.pitch_env ? (t: number) => pitchEnvSemitones(src.pitch_env!, t) : () => 0;
      return {
        sampleRate,
        channels: matched.channels.map((ch) => {
          if (!pitched) {
            // pad or trim to the layer length
            const out = new Float32Array(lengthSamples);
            out.set(ch.subarray(0, Math.min(ch.length, lengthSamples)));
            return out;
          }
          return varispeed(ch, lengthSamples, src.rate, semitonesAt);
        }),
      };
    }
    case "granular": {
      const file = await ctx.loadRef(src.file);
      const monoSrc = matchChannels(file, 1).channels[0];
      const mono = renderGranular(lengthSamples, sampleRate, monoSrc, src, seed);
      return matchChannels({ sampleRate, channels: [mono] }, numChannels);
    }
  }
}

function applyGainLfo(buf: AudioBuf, lfo: Lfo): void {
  const dtSec = 1 / buf.sampleRate;
  for (const ch of buf.channels) {
    const osc = makeLfo(lfo);
    const n = ch.length;
    for (let i = 0; i < n; i++) {
      ch[i] *= dbToLin(osc(i / Math.max(1, n - 1), dtSec) * lfo.depth);
    }
  }
}

/** Extra samples delay and reverb need to ring out past duration_ms. */
async function busTailSamples(recipe: Recipe, ctx: EngineContext, sampleRate: number): Promise<number> {
  let tail = 0;
  for (const fx of recipe.bus) {
    if (fx.type === "delay") {
      // echoes until the feedback chain falls 80 dB
      const echoes = fx.feedback > 0 ? Math.ceil(80 / (-20 * Math.log10(fx.feedback))) : 1;
      tail += Math.round((fx.time_ms / 1000) * sampleRate) * echoes;
    } else if (fx.type === "reverb") {
      const irFile = ctx.project.palette.irs[fx.ir] ?? fx.ir;
      if (irFile.startsWith("refs/")) {
        const ir = await ctx.loadRef(irFile);
        tail += ir.channels[0].length + Math.round((fx.predelay_ms / 1000) * sampleRate);
      }
    }
  }
  return Math.min(tail, Math.round(TAIL_CAP_SECONDS * sampleRate));
}

/** Trim trailing samples below the threshold, never cutting into the recipe's own duration. */
function trimTail(mix: AudioBuf, minSamples: number, sampleRate: number): AudioBuf {
  const n = bufLength(mix);
  let last = minSamples - 1;
  for (const ch of mix.channels) {
    for (let i = n - 1; i > last; i--) {
      if (Math.abs(ch[i]) > TAIL_TRIM_THRESHOLD) {
        last = i;
        break;
      }
    }
  }
  const pad = Math.round(0.03 * sampleRate);
  const outLen = Math.min(n, Math.max(minSamples, last + 1 + pad));
  if (outLen >= n) return mix;
  return { sampleRate: mix.sampleRate, channels: mix.channels.map((ch) => ch.slice(0, outLen)) };
}

/**
 * One-pole DC blocker (~5 Hz high-pass) on the master bus: y[n] = x[n] - x[n-1]
 * + R*y[n-1]. Removes DC that appears after the per-layer highpass slot — e.g.
 * from a bus waveshaper's asymmetric transfer — which no layer filter can reach.
 * It decays trailing silence cleanly to zero (so tail trimming still works),
 * unlike mean-subtraction which would leave a DC pedestal. The finite-length
 * startup transient leaves a small residual in the whole-buffer DC metric that
 * shrinks with duration, so very short, heavily-DC sounds may still trip E102.
 */
export function applyDcBlock(mix: AudioBuf): void {
  const R = Math.exp((-2 * Math.PI * 5) / mix.sampleRate);
  for (const ch of mix.channels) {
    let prevIn = 0;
    let prevOut = 0;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      const y = x - prevIn + R * prevOut;
      prevIn = x;
      prevOut = y;
      ch[i] = y;
    }
  }
}

function applyMasterFades(mix: AudioBuf, recipe: Recipe): void {
  const n = bufLength(mix);
  const sr = mix.sampleRate;
  const fadeIn = Math.min(n, Math.round((recipe.master.fade_in_ms / 1000) * sr));
  const fadeOut = Math.min(n, Math.round((recipe.master.fade_out_ms / 1000) * sr));
  for (const ch of mix.channels) {
    for (let i = 0; i < fadeIn; i++) {
      ch[i] *= curveInterp(0, 1, (i + 1) / fadeIn, recipe.master.fade_curve);
    }
    for (let i = 0; i < fadeOut; i++) {
      ch[n - 1 - i] *= curveInterp(0, 1, (i + 1) / fadeOut, recipe.master.fade_curve);
    }
  }
}

export async function renderRecipe(recipe: Recipe, ctx: EngineContext, variantIndex?: number): Promise<RenderResult> {
  const sampleRate = ctx.project.sample_rate;
  const numChannels = (recipe.channels ?? ctx.project.channels_default) === "stereo" ? 2 : 1;
  const totalSamples = Math.round((recipe.duration_ms / 1000) * sampleRate);
  const jitter = variantIndex != null ? drawVariantJitter(recipe, variantIndex) : null;

  const tailSamples = recipe.loop.enabled ? 0 : await busTailSamples(recipe, ctx, sampleRate);
  const mix = createBuf(sampleRate, numChannels, totalSamples + tailSamples);
  const layerBufs: { id: string; buf: AudioBuf }[] = [];

  for (const layer of recipe.layers) {
    const seed = hashSeed(recipe.seed, layer.id);
    const delayMs = Math.max(0, layer.delay_ms + (jitter?.layerDelayMs.get(layer.id) ?? 0));
    const delaySamples = Math.min(totalSamples - 1, Math.round((delayMs / 1000) * sampleRate));
    const layerLen = totalSamples - delaySamples;

    let buf = await renderSource(layer, layerLen, sampleRate, numChannels, seed, ctx);

    if (jitter && Math.abs(jitter.pitchSemitones) > 1e-6) {
      buf = {
        sampleRate,
        channels: buf.channels.map((ch) => {
          const shifted = pitchShift(ch, jitter.pitchSemitones);
          const out = new Float32Array(layerLen);
          out.set(shifted.subarray(0, Math.min(shifted.length, layerLen)));
          return out;
        }),
      };
    }

    const cutoffMuls = jitter?.cutoffMul.get(layer.id);
    const cutoffLfoSpec = layer.lfo?.target === "cutoff" ? layer.lfo : undefined;
    layer.filters.forEach((filter, fi) => {
      const cutoff = filter.cutoff_hz * (cutoffMuls?.[fi] ?? 1);
      for (const ch of buf.channels) {
        const cutoffLfo = cutoffLfoSpec ? { depthPct: cutoffLfoSpec.depth, next: makeLfo(cutoffLfoSpec) } : undefined;
        applyFilter(ch, sampleRate, filter.type, cutoff, filter.q, filter.gain_db, filter.sweep, cutoffLfo);
      }
    });

    for (const ch of buf.channels) applyEnvelope(ch, sampleRate, layer.envelope);

    if (layer.lfo?.target === "gain") applyGainLfo(buf, layer.lfo);

    const gain = dbToLin(layer.gain_db);

    // layer contribution aligned to the mix timeline, for masking analysis
    const aligned = createBuf(sampleRate, numChannels, totalSamples);
    for (let c = 0; c < numChannels; c++) {
      mixInto(aligned.channels[c], buf.channels[c], delaySamples, gain);
      mixInto(mix.channels[c], buf.channels[c], delaySamples, gain);
    }
    layerBufs.push({ id: layer.id, buf: aligned });
  }

  for (const fx of recipe.bus) {
    switch (fx.type) {
      case "reverb": {
        const irFile = ctx.project.palette.irs[fx.ir] ?? fx.ir;
        if (!irFile.startsWith("refs/")) {
          throw new Error(
            `unknown IR "${fx.ir}"; palette has: ${Object.keys(ctx.project.palette.irs).join(", ") || "(none)"} (or pass a refs/ path)`,
          );
        }
        const ir = await ctx.loadRef(irFile);
        applyReverb(mix, ir, fx.wet, fx.predelay_ms);
        break;
      }
      case "delay":
        applyDelay(mix, fx.time_ms, fx.feedback, fx.wet);
        break;
      case "eq":
        applyEq(mix, sampleRate, fx.bands);
        break;
      case "waveshaper":
        applyWaveshaper(mix, fx.drive_db, fx.shape);
        break;
      case "compressor":
        applyCompressor(mix, sampleRate, fx.threshold_db, fx.ratio, fx.attack_ms, fx.release_ms);
        break;
    }
  }

  const masterGain = dbToLin(recipe.master.gain_db + (jitter?.gainDb ?? 0));
  for (const ch of mix.channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= masterGain;
  }

  if (recipe.master.dc_block) applyDcBlock(mix);

  let finalMix = mix;
  if (recipe.loop.enabled) {
    finalMix = applyLoopCrossfade(mix, recipe.loop.crossfade_ms);
    // trim layer contributions to the loop length so analysis timelines agree
    const loopLen = finalMix.channels[0].length;
    for (const lb of layerBufs) {
      lb.buf = { sampleRate, channels: lb.buf.channels.map((ch) => ch.slice(0, loopLen)) };
    }
  } else {
    if (tailSamples > 0) finalMix = trimTail(mix, totalSamples, sampleRate);
    applyMasterFades(finalMix, recipe);
  }

  return { mix: finalMix, layers: layerBufs };
}
