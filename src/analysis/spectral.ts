/**
 * STFT-based features: centroid trajectory, fixed band-energy table,
 * resonance peaks. Power is normalized so a full-scale sine reads ~-3 dB,
 * matching its RMS.
 */

import { AudioBuf, toMono } from "../dsp/buffer.js";
import { magnitudes, hannWindow } from "../dsp/fft.js";
import { round1 } from "./measure.js";

export const FFT_SIZE = 1024;
export const HOP = 256;

export const BANDS: [string, number, number][] = [
  ["20-60", 20, 60],
  ["60-150", 60, 150],
  ["150-400", 150, 400],
  ["400-1k", 400, 1000],
  ["1k-2.5k", 1000, 2500],
  ["2.5k-6k", 2500, 6000],
  ["6k-12k", 6000, 12000],
  ["12k-20k", 12000, 20000],
];

export interface Stft {
  /** power per bin per frame, normalized so full-scale sine sums to 0.5 (=-3 dB) */
  frames: Float64Array[];
  times_ms: number[];
  binHz: number;
  sampleRate: number;
}

export function stft(buf: AudioBuf, fftSize = FFT_SIZE, hop = HOP): Stft {
  const mono = toMono(buf).channels[0];
  const window = hannWindow(fftSize);
  let windowSum = 0;
  for (let i = 0; i < fftSize; i++) windowSum += window[i];
  const norm = 2 / (windowSum * windowSum); // power normalization: FS sine -> 0.5

  const frames: Float64Array[] = [];
  const times: number[] = [];
  const padded = new Float64Array(fftSize);
  const numFrames = Math.max(1, Math.floor((mono.length - 1) / hop) + 1);
  for (let f = 0; f < numFrames; f++) {
    const start = f * hop;
    padded.fill(0);
    for (let i = 0; i < fftSize && start + i < mono.length; i++) {
      padded[i] = mono[start + i] * window[i];
    }
    const mags = magnitudes(padded, fftSize);
    const power = new Float64Array(mags.length);
    for (let k = 0; k < mags.length; k++) power[k] = mags[k] * mags[k] * norm;
    frames.push(power);
    times.push(((start + fftSize / 2) / buf.sampleRate) * 1000);
  }
  return { frames, times_ms: times, binHz: buf.sampleRate / fftSize, sampleRate: buf.sampleRate };
}

function frameCentroid(power: Float64Array, binHz: number): number | null {
  let num = 0;
  let den = 0;
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz;
    if (f < 20 || f > 20000) continue;
    num += f * power[k];
    den += power[k];
  }
  return den < 1e-12 ? null : num / den;
}

export interface CentroidTrajectory {
  mean: number;
  at_10ms: number | null;
  at_100ms: number | null;
  at_end: number | null;
}

export function centroidTrajectory(s: Stft): CentroidTrajectory {
  const centroids = s.frames.map((p) => frameCentroid(p, s.binHz));
  const energies = s.frames.map((p) => p.reduce((a, b) => a + b, 0));

  let num = 0;
  let den = 0;
  centroids.forEach((c, i) => {
    if (c !== null) {
      num += c * energies[i];
      den += energies[i];
    }
  });
  const mean = den < 1e-12 ? 0 : num / den;

  const at = (ms: number): number | null => {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < s.times_ms.length; i++) {
      const d = Math.abs(s.times_ms[i] - ms);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best < 0 ? null : centroids[best];
  };

  // at_end: last frame with energy above -70 dB
  let endIdx = -1;
  for (let i = energies.length - 1; i >= 0; i--) {
    if (10 * Math.log10(Math.max(energies[i], 1e-12)) > -70) {
      endIdx = i;
      break;
    }
  }

  const r = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    mean: Math.round(mean),
    at_10ms: r(at(10)),
    at_100ms: r(at(100)),
    at_end: endIdx < 0 ? null : r(centroids[endIdx]),
  };
}

/** Mean power spectrum across all frames. */
export function averageSpectrum(s: Stft): Float64Array {
  const avg = new Float64Array(s.frames[0].length);
  for (const frame of s.frames) {
    for (let k = 0; k < avg.length; k++) avg[k] += frame[k];
  }
  for (let k = 0; k < avg.length; k++) avg[k] /= s.frames.length;
  return avg;
}

export function bandEnergyDb(s: Stft): Record<string, number> {
  const avg = averageSpectrum(s);
  const out: Record<string, number> = {};
  for (const [label, lo, hi] of BANDS) {
    let sum = 0;
    for (let k = 1; k < avg.length; k++) {
      const f = k * s.binHz;
      if (f >= lo && f < hi) sum += avg[k];
    }
    out[label] = round1(10 * Math.log10(Math.max(sum, 1e-12)));
  }
  return out;
}

/** Energy below the given frequency, in dB, for the W201 rumble check. */
export function energyBelowDb(s: Stft, hz: number): number {
  const avg = averageSpectrum(s);
  let sum = 0;
  for (let k = 1; k < avg.length; k++) {
    if (k * s.binHz < hz) sum += avg[k];
  }
  return 10 * Math.log10(Math.max(sum, 1e-12));
}

export interface Resonance {
  freq_hz: number;
  prominence_db: number;
}

/**
 * Peaks in the average spectrum standing at least 8 dB over a 1/3-octave
 * smoothed baseline; top five by prominence.
 */
export function findResonances(s: Stft, maxCount = 5): Resonance[] {
  const avg = averageSpectrum(s);
  const db = new Float64Array(avg.length);
  for (let k = 0; k < avg.length; k++) db[k] = 10 * Math.log10(Math.max(avg[k], 1e-14));

  const baseline = new Float64Array(avg.length);
  for (let k = 1; k < avg.length; k++) {
    const half = Math.max(2, Math.round(k * (Math.pow(2, 1 / 6) - 1))); // ±1/6 octave in bins
    let sum = 0;
    let count = 0;
    for (let j = Math.max(1, k - half); j < Math.min(avg.length, k + half + 1); j++) {
      sum += db[j];
      count++;
    }
    baseline[k] = sum / count;
  }

  const found: Resonance[] = [];
  for (let k = 2; k < avg.length - 2; k++) {
    const f = k * s.binHz;
    if (f < 40 || f > 16000) continue;
    if (db[k] > db[k - 1] && db[k] >= db[k + 1]) {
      const prom = db[k] - baseline[k];
      if (prom >= 8 && db[k] > -60) {
        // parabolic interpolation for a better frequency estimate
        const denom = db[k - 1] - 2 * db[k] + db[k + 1];
        const delta = denom === 0 ? 0 : (0.5 * (db[k - 1] - db[k + 1])) / denom;
        found.push({ freq_hz: Math.round((k + delta) * s.binHz), prominence_db: round1(prom) });
      }
    }
  }
  found.sort((a, b) => b.prominence_db - a.prominence_db);
  // drop near-duplicates within 5%
  const dedup: Resonance[] = [];
  for (const r of found) {
    if (!dedup.some((d) => Math.abs(d.freq_hz - r.freq_hz) / r.freq_hz < 0.05)) dedup.push(r);
    if (dedup.length >= maxCount) break;
  }
  return dedup.sort((a, b) => a.freq_hz - b.freq_hz);
}
