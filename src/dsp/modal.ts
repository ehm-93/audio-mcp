/**
 * Modal synthesis: a bank of two-pole resonators excited by an impulse or a
 * short noise burst. decay_ms is time to -60 dB per mode. Each mode is scaled
 * by sin(theta) so its impulse-response peak sits near unity before gain_db.
 *
 * A 15 Hz DC blocker runs on the summed output: an impulse-excited resonator
 * integrates to nonzero area, which otherwise reads as a real DC offset on
 * short renders (E102 on every modal recipe).
 */

import { mulberry32 } from "./prng.js";
import { dbToLin } from "./buffer.js";

export interface Mode {
  freq_hz: number;
  decay_ms: number;
  gain_db: number;
}

export function renderModal(
  length: number,
  sampleRate: number,
  modes: Mode[],
  excite: "impulse" | "noise",
  exciteMs: number,
  seed: number,
): Float32Array {
  const excitation = new Float32Array(length);
  if (excite === "impulse") {
    excitation[0] = 1;
  } else {
    const rand = mulberry32(seed);
    const n = Math.max(1, Math.min(length, Math.round((exciteMs / 1000) * sampleRate)));
    for (let i = 0; i < n; i++) {
      const decay = 1 - i / n;
      excitation[i] = (rand() * 2 - 1) * decay * 0.5;
    }
  }

  const out = new Float32Array(length);
  for (const mode of modes) {
    const freq = Math.min(mode.freq_hz, sampleRate / 2 - 100);
    if (freq <= 0) continue;
    const theta = (2 * Math.PI * freq) / sampleRate;
    // r per sample so that amplitude falls 60 dB over decay_ms
    const decaySamples = Math.max(1, (mode.decay_ms / 1000) * sampleRate);
    const r = Math.pow(10, -3 / decaySamples);
    const a1 = 2 * r * Math.cos(theta);
    const a2 = -r * r;
    const scale = Math.sin(theta) * dbToLin(mode.gain_db);

    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < length; i++) {
      const y = excitation[i] + a1 * y1 + a2 * y2;
      y2 = y1;
      y1 = y;
      out[i] += y * scale;
    }
  }

  // DC blocker: one-pole highpass at ~15 Hz
  const r = 1 - (2 * Math.PI * 15) / sampleRate;
  let x1 = 0;
  let yPrev = 0;
  for (let i = 0; i < length; i++) {
    const y = out[i] - x1 + r * yPrev;
    x1 = out[i];
    yPrev = y;
    out[i] = y;
  }
  return out;
}
