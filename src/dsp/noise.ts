/**
 * Seeded colored noise. Each color is normalized to -12 dBFS RMS so layer
 * gain_db means the same thing regardless of color.
 */

import { mulberry32 } from "./prng.js";

export type NoiseColor = "white" | "pink" | "brown" | "blue";

export function renderNoise(length: number, color: NoiseColor, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(length);

  if (color === "white") {
    for (let i = 0; i < length; i++) out[i] = rand() * 2 - 1;
  } else if (color === "pink") {
    // Paul Kellet's economy pink filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  } else if (color === "brown") {
    let acc = 0;
    for (let i = 0; i < length; i++) {
      acc = acc * 0.999 + (rand() * 2 - 1) * 0.05;
      out[i] = acc;
    }
  } else {
    // blue: differentiated pink, +3 dB/oct
    const pink = renderNoise(length, "pink", seed);
    out[0] = pink[0];
    for (let i = 1; i < length; i++) out[i] = pink[i] - pink[i - 1];
  }

  normalizeRms(out, 0.25); // -12 dBFS
  return out;
}

function normalizeRms(buf: Float32Array, targetRms: number): void {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms < 1e-9) return;
  const g = targetRms / rms;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
}
