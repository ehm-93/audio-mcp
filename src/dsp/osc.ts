/**
 * Band-limited oscillators. Saw, square, and pulse use polyBLEP edge
 * correction; triangle is a leaky integration of the polyBLEP square; sine is
 * exact. Pulse subtracts its duty-cycle DC offset (mean of a naive pulse is
 * 2*duty - 1, far from zero at narrow widths).
 *
 * Pitch can move three ways, all composable: a pitch envelope (single sweep
 * or breakpoints), and a pitch LFO whose rate may itself sweep.
 */

import { CurveName, curveInterp } from "./biquad.js";
import { PitchEnv, Lfo } from "../schema.js";

export type OscShape = "sine" | "triangle" | "saw" | "square" | "pulse";

/** Pitch envelope offset in semitones at normalized time t. */
export function pitchEnvSemitones(pe: PitchEnv, t: number): number {
  if (pe.points) {
    const points = pe.points;
    if (t <= points[0].at) return points[0].semitones;
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i].at) {
        const span = points[i].at - points[i - 1].at;
        const local = span <= 0 ? 1 : (t - points[i - 1].at) / span;
        return curveInterp(points[i - 1].semitones, points[i].semitones, local, pe.curve);
      }
    }
    return points[points.length - 1].semitones;
  }
  return curveInterp(0, pe.end_semitones ?? 0, t, pe.curve);
}

/**
 * Incremental sine LFO whose rate sweeps from rate_hz to rate_end_hz across
 * the layer. Call next(t, dtSeconds) sequentially; deterministic from phase 0.
 */
export function makeLfo(lfo: Lfo): (t: number, dtSeconds: number) => number {
  let phase = 0;
  return (t: number, dtSeconds: number) => {
    const rate = curveInterp(lfo.rate_hz, lfo.rate_end_hz ?? lfo.rate_hz, t, lfo.curve);
    const value = Math.sin(2 * Math.PI * phase);
    phase += rate * dtSeconds;
    return value;
  };
}

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export function renderOsc(
  length: number,
  sampleRate: number,
  shape: OscShape,
  freqHz: number,
  duty = 0.5,
  pitchEnv?: PitchEnv,
  pitchLfo?: Lfo,
): Float32Array {
  const out = new Float32Array(length);
  let phase = 0;
  let triState = 0;
  const width = Math.min(0.95, Math.max(0.05, duty));
  const pulseDc = 2 * width - 1;
  const lfo = pitchLfo ? makeLfo(pitchLfo) : null;
  const dtSec = 1 / sampleRate;

  for (let i = 0; i < length; i++) {
    const t = i / Math.max(1, length - 1);
    let semis = 0;
    if (pitchEnv) semis += pitchEnvSemitones(pitchEnv, t);
    if (lfo && pitchLfo) semis += lfo(t, dtSec) * pitchLfo.depth;
    const freq = semis !== 0 ? freqHz * Math.pow(2, semis / 12) : freqHz;
    const dt = Math.min(0.49, Math.max(1e-7, freq / sampleRate));

    let v: number;
    switch (shape) {
      case "sine":
        v = Math.sin(2 * Math.PI * phase);
        break;
      case "saw":
        v = 2 * phase - 1 - polyBlep(phase, dt);
        break;
      case "square":
      case "pulse": {
        const w = shape === "square" ? 0.5 : width;
        v = phase < w ? 1 : -1;
        v += polyBlep(phase, dt);
        v -= polyBlep((phase - w + 1) % 1, dt);
        if (shape === "pulse") v -= pulseDc;
        break;
      }
      case "triangle": {
        // integrate a polyBLEP square; leak keeps DC from accumulating
        let sq = phase < 0.5 ? 1 : -1;
        sq += polyBlep(phase, dt);
        sq -= polyBlep((phase + 0.5) % 1, dt);
        triState = triState * (1 - dt * 0.25) + sq * 4 * dt;
        v = triState;
        break;
      }
    }
    out[i] = v;
    phase += dt;
    if (phase >= 1) phase -= 1;
  }
  return out;
}
