/**
 * Granular texture source: Hann-windowed grains scattered from a source file
 * at density_hz, with seeded position and pitch jitter.
 */

import { mulberry32 } from "./prng.js";
import { resample } from "./resample.js";

export interface GranularSpec {
  grain_ms: number;
  density_hz: number;
  position: number; // 0..1 within the source
  position_jitter: number; // 0..1, half-width
  pitch_jitter_semitones: number;
}

export function renderGranular(
  length: number,
  sampleRate: number,
  source: Float32Array,
  spec: GranularSpec,
  seed: number,
): Float32Array {
  const out = new Float32Array(length);
  const rand = mulberry32(seed);
  const grainLen = Math.max(8, Math.round((spec.grain_ms / 1000) * sampleRate));
  const interval = sampleRate / Math.max(0.1, spec.density_hz);
  // overlap compensation: average grain overlap is grainLen / interval
  const overlap = Math.max(1, grainLen / interval);
  const grainGain = 1 / Math.sqrt(overlap);

  for (let onset = 0; onset < length; onset += interval * (0.7 + 0.6 * rand())) {
    const onsetI = Math.round(onset);
    const posJit = (rand() * 2 - 1) * spec.position_jitter;
    const pos = Math.min(1, Math.max(0, spec.position + posJit));
    let srcStart = Math.round(pos * Math.max(0, source.length - grainLen));

    let grain = source.subarray(srcStart, Math.min(source.length, srcStart + grainLen));
    if (spec.pitch_jitter_semitones > 0) {
      const semis = (rand() * 2 - 1) * spec.pitch_jitter_semitones;
      grain = resample(grain as Float32Array, 1 / Math.pow(2, semis / 12));
    }

    const gl = grain.length;
    for (let i = 0; i < gl; i++) {
      const oi = onsetI + i;
      if (oi >= length) break;
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (gl - 1)));
      out[oi] += grain[i] * w * grainGain;
    }
  }
  return out;
}
