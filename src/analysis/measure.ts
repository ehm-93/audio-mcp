/** Time-domain measurements: peak, true peak, RMS, DC, attack/decay/tail timing. */

import { AudioBuf, linToDb } from "../dsp/buffer.js";
import { resample } from "../dsp/resample.js";

export function peakDbfs(buf: AudioBuf): number {
  let peak = 0;
  for (const ch of buf.channels) {
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  }
  return linToDb(peak);
}

/** True peak via 4x windowed-sinc oversampling (exceeds the BS.1770-4 interpolator). */
export function truePeakDbtp(buf: AudioBuf): number {
  let peak = 0;
  for (const ch of buf.channels) {
    const over = resample(ch, 4);
    for (let i = 0; i < over.length; i++) peak = Math.max(peak, Math.abs(over[i]));
  }
  return linToDb(peak);
}

export function rmsDbfs(buf: AudioBuf): number {
  let sum = 0;
  let count = 0;
  for (const ch of buf.channels) {
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    count += ch.length;
  }
  return count === 0 ? -Infinity : linToDb(Math.sqrt(sum / count));
}

export function dcOffsetDb(buf: AudioBuf): number {
  let worst = 0;
  for (const ch of buf.channels) {
    let mean = 0;
    for (let i = 0; i < ch.length; i++) mean += ch[i];
    mean /= Math.max(1, ch.length);
    worst = Math.max(worst, Math.abs(mean));
  }
  return linToDb(worst);
}

/** Short-window RMS envelope in dBFS. Window ~5.8ms, hop ~1.45ms at 44.1k. */
export function rmsEnvelopeDb(buf: AudioBuf, windowSamples = 256, hop = 64): { times_ms: Float64Array; db: Float64Array } {
  const n = buf.channels[0].length;
  const frames = Math.max(1, Math.floor((n - windowSamples) / hop) + 1);
  const db = new Float64Array(frames);
  const times = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    let sum = 0;
    let count = 0;
    for (const ch of buf.channels) {
      const end = Math.min(n, start + windowSamples);
      for (let i = start; i < end; i++) sum += ch[i] * ch[i];
      count += end - start;
    }
    db[f] = count === 0 ? -Infinity : linToDb(Math.sqrt(sum / count));
    times[f] = ((start + windowSamples / 2) / buf.sampleRate) * 1000;
  }
  return { times_ms: times, db };
}

export interface TimingStats {
  attack_ms: number;
  decay_to_minus40_ms: number | null;
  tail_silence_ms: number;
}

/**
 * attack_ms: time from start to the envelope first reaching peak - 1 dB.
 * decay_to_minus40_ms: time from the envelope peak until the envelope last
 * drops below peak - 40 dB for good (null if it never decays that far).
 * tail_silence_ms: trailing time below -60 dBFS.
 */
export function timingStats(buf: AudioBuf): TimingStats {
  const env = rmsEnvelopeDb(buf);
  const frames = env.db.length;
  let peakDb = -Infinity;
  let peakIdx = 0;
  for (let i = 0; i < frames; i++) {
    if (env.db[i] > peakDb) {
      peakDb = env.db[i];
      peakIdx = i;
    }
  }

  let attackIdx = peakIdx;
  for (let i = 0; i <= peakIdx; i++) {
    if (env.db[i] >= peakDb - 1) {
      attackIdx = i;
      break;
    }
  }

  let decayIdx: number | null = null;
  for (let i = frames - 1; i > peakIdx; i--) {
    if (env.db[i] >= peakDb - 40) {
      decayIdx = i + 1 < frames ? i + 1 : null;
      break;
    }
  }
  if (decayIdx === null && peakIdx < frames - 1 && env.db[frames - 1] < peakDb - 40) {
    decayIdx = peakIdx + 1; // decayed immediately after the peak
  }

  let tailIdx = frames;
  for (let i = frames - 1; i >= 0; i--) {
    if (env.db[i] >= -60) {
      tailIdx = i + 1;
      break;
    }
    if (i === 0) tailIdx = 0;
  }

  const durationMs = (buf.channels[0].length / buf.sampleRate) * 1000;
  return {
    attack_ms: round1(env.times_ms[attackIdx]),
    decay_to_minus40_ms: decayIdx === null ? null : round1(Math.max(0, env.times_ms[decayIdx] - env.times_ms[peakIdx])),
    tail_silence_ms: round1(tailIdx >= frames ? 0 : Math.max(0, durationMs - env.times_ms[tailIdx])),
  };
}

export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
