/**
 * AHDSR over a fixed layer duration. Attack, hold, decay run from layer
 * start; sustain holds until duration minus release. Curve shapes the level
 * trajectory of each moving segment: exp = fast initial change with an
 * asymptotic tail (natural percussive decay), log = the mirror. Per-segment
 * overrides (attack_curve, decay_curve, release_curve) fall back to curve,
 * so a slow log swell can still end in a click-free lin or exp release.
 */

import { CurveName, curveInterp } from "./biquad.js";

export interface EnvelopeSpec {
  attack_ms: number;
  hold_ms: number;
  decay_ms: number;
  sustain: number;
  release_ms: number;
  curve: CurveName;
  attack_curve?: CurveName;
  decay_curve?: CurveName;
  release_curve?: CurveName;
}

export function applyEnvelope(buf: Float32Array, sampleRate: number, env: EnvelopeSpec): void {
  const n = buf.length;
  const toSamples = (ms: number) => Math.round((ms / 1000) * sampleRate);
  const a = toSamples(env.attack_ms);
  const h = toSamples(env.hold_ms);
  const d = toSamples(env.decay_ms);
  const r = toSamples(env.release_ms);
  const releaseStart = Math.max(0, n - r);
  const attackCurve = env.attack_curve ?? env.curve;
  const decayCurve = env.decay_curve ?? env.curve;
  const releaseCurve = env.release_curve ?? env.curve;

  for (let i = 0; i < n; i++) {
    let level: number;
    if (i < a) level = curveInterp(0, 1, (i + 1) / a, attackCurve);
    else if (i < a + h) level = 1;
    else if (i < a + h + d) level = curveInterp(1, env.sustain, (i - a - h + 1) / d, decayCurve);
    else level = env.sustain;

    if (r > 0 && i >= releaseStart) {
      level *= curveInterp(1, 0, (i - releaseStart + 1) / r, releaseCurve);
    }
    buf[i] *= level;
  }
}
