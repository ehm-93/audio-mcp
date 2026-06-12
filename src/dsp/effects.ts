/** Bus effects: convolution reverb, feedback delay, parametric EQ, waveshaper, compressor. */

import { AudioBuf, dbToLin, linToDb } from "./buffer.js";
import { Biquad, biquadCoeffs } from "./biquad.js";
import { nextPow2, rfft, irfft } from "./fft.js";

/** FFT convolution of one channel against an IR channel; output truncated to signal length. */
function convolveTruncated(signal: Float32Array, ir: Float32Array): Float32Array {
  const fullLen = signal.length + ir.length - 1;
  const size = nextPow2(fullLen);
  const a = rfft(signal, size);
  const b = rfft(ir, size);
  const prod = new Float64Array(2 * size);
  for (let i = 0; i < size; i++) {
    const re = a[2 * i] * b[2 * i] - a[2 * i + 1] * b[2 * i + 1];
    const im = a[2 * i] * b[2 * i + 1] + a[2 * i + 1] * b[2 * i];
    prod[2 * i] = re;
    prod[2 * i + 1] = im;
  }
  const conv = irfft(prod, size);
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = conv[i];
  return out;
}

/** Normalize an IR so convolution preserves rough loudness regardless of IR level. */
function irEnergyNorm(ir: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < ir.length; i++) sum += ir[i] * ir[i];
  const norm = Math.sqrt(sum);
  if (norm < 1e-9) return ir;
  const out = new Float32Array(ir.length);
  for (let i = 0; i < ir.length; i++) out[i] = ir[i] / norm;
  return out;
}

export function applyReverb(buf: AudioBuf, ir: AudioBuf, wet: number, predelayMs: number): void {
  const predelay = Math.round((predelayMs / 1000) * buf.sampleRate);
  for (let c = 0; c < buf.channels.length; c++) {
    const irCh = irEnergyNorm(ir.channels[Math.min(c, ir.channels.length - 1)]);
    const wetSig = convolveTruncated(buf.channels[c], irCh);
    const dry = buf.channels[c];
    for (let i = 0; i < dry.length; i++) {
      const w = i >= predelay ? wetSig[i - predelay] : 0;
      dry[i] = dry[i] * (1 - wet) + w * wet;
    }
  }
}

export function applyDelay(buf: AudioBuf, timeMs: number, feedback: number, wet: number): void {
  const delaySamples = Math.max(1, Math.round((timeMs / 1000) * buf.sampleRate));
  for (const ch of buf.channels) {
    const line = new Float32Array(delaySamples);
    let pos = 0;
    for (let i = 0; i < ch.length; i++) {
      const delayed = line[pos];
      line[pos] = ch[i] + delayed * feedback;
      pos = (pos + 1) % delaySamples;
      ch[i] = ch[i] * (1 - wet) + delayed * wet;
    }
  }
}

export function applyEq(buf: AudioBuf, sampleRate: number, bands: { freq_hz: number; gain_db: number; q: number }[]): void {
  for (const ch of buf.channels) {
    for (const band of bands) {
      new Biquad(biquadCoeffs("peak", sampleRate, band.freq_hz, band.q, band.gain_db)).process(ch);
    }
  }
}

export function applyWaveshaper(buf: AudioBuf, driveDb: number, shape: "tanh" | "fold"): void {
  const drive = dbToLin(driveDb);
  for (const ch of buf.channels) {
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i] * drive;
      if (shape === "tanh") {
        ch[i] = Math.tanh(x);
      } else {
        // triangle fold into -1..1
        const t = (x + 1) / 4;
        const frac = t - Math.floor(t);
        ch[i] = Math.abs(frac * 4 - 2) - 1;
      }
    }
  }
}

export function applyCompressor(
  buf: AudioBuf,
  sampleRate: number,
  thresholdDb: number,
  ratio: number,
  attackMs: number,
  releaseMs: number,
): void {
  const attackCoef = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
  const releaseCoef = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const n = buf.channels[0].length;
  let env = 0;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const ch of buf.channels) peak = Math.max(peak, Math.abs(ch[i]));
    const coef = peak > env ? attackCoef : releaseCoef;
    env = coef * env + (1 - coef) * peak;
    const envDb = linToDb(Math.max(env, 1e-7));
    let gainDb = 0;
    if (envDb > thresholdDb) {
      gainDb = (thresholdDb - envDb) * (1 - 1 / ratio);
    }
    const g = dbToLin(gainDb);
    for (const ch of buf.channels) ch[i] *= g;
  }
}
