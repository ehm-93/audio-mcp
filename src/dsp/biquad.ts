/** RBJ cookbook biquads, with optional cutoff sweep across the buffer. */

export type FilterType = "lowpass" | "highpass" | "bandpass" | "notch" | "peak" | "lowshelf" | "highshelf";

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function biquadCoeffs(type: FilterType, sampleRate: number, freq: number, q: number, gainDb = 0): BiquadCoeffs {
  const f = Math.max(10, Math.min(freq, sampleRate / 2 - 10));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const Q = Math.max(0.05, q);
  const alpha = sinW0 / (2 * Q);
  const A = Math.pow(10, gainDb / 40);

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case "lowpass":
      b0 = (1 - cosW0) / 2; b1 = 1 - cosW0; b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha;
      break;
    case "highpass":
      b0 = (1 + cosW0) / 2; b1 = -(1 + cosW0); b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha;
      break;
    case "bandpass": // constant 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha;
      break;
    case "notch":
      b0 = 1; b1 = -2 * cosW0; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha;
      break;
    case "peak":
      b0 = 1 + alpha * A; b1 = -2 * cosW0; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cosW0; a2 = 1 - alpha / A;
      break;
    case "lowshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cosW0 + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
      b2 = A * (A + 1 - (A - 1) * cosW0 - s);
      a0 = A + 1 + (A - 1) * cosW0 + s;
      a1 = -2 * (A - 1 + (A + 1) * cosW0);
      a2 = A + 1 + (A - 1) * cosW0 - s;
      break;
    }
    case "highshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cosW0 + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
      b2 = A * (A + 1 + (A - 1) * cosW0 - s);
      a0 = A + 1 - (A - 1) * cosW0 + s;
      a1 = 2 * (A - 1 - (A + 1) * cosW0);
      a2 = A + 1 - (A - 1) * cosW0 - s;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(public c: BiquadCoeffs) {}

  processSample(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  process(buf: Float32Array): void {
    for (let i = 0; i < buf.length; i++) buf[i] = this.processSample(buf[i]);
  }
}

export type CurveName = "lin" | "exp" | "log";

/** Interpolate a value from start to end with the given curve, t in 0..1. */
export function curveInterp(start: number, end: number, t: number, curve: CurveName): number {
  let f: number;
  if (curve === "exp") f = 1 - Math.exp(-6.9 * t); // fast initial change, asymptotic
  else if (curve === "log") f = Math.exp(-6.9 * (1 - t)); // slow initial change
  else f = t;
  if (curve !== "lin") f = Math.min(1, f / (1 - Math.exp(-6.9))); // normalize to hit end exactly
  return start + (end - start) * f;
}

/** Frequency-domain interpolation is more natural geometrically when both ends are positive. */
export function curveInterpFreq(startHz: number, endHz: number, t: number, curve: CurveName): number {
  if (startHz > 0 && endHz > 0) {
    const logV = curveInterp(Math.log(startHz), Math.log(endHz), t, curve);
    return Math.exp(logV);
  }
  return curveInterp(startHz, endHz, t, curve);
}

export interface CutoffLfo {
  /** percent half-width of cutoff deviation */
  depthPct: number;
  /** sequential sine LFO; called once per 32-sample block */
  next: (t: number, dtSeconds: number) => number;
}

/**
 * Apply a biquad with an optional cutoff sweep and/or cutoff LFO.
 * Coefficients are recomputed every 32 samples, which is inaudible at the
 * modulation rates recipes can express.
 */
export function applyFilter(
  buf: Float32Array,
  sampleRate: number,
  type: FilterType,
  cutoffHz: number,
  q: number,
  gainDb: number,
  sweep?: { end_hz: number; curve: CurveName },
  cutoffLfo?: CutoffLfo,
): void {
  if (!sweep && !cutoffLfo) {
    new Biquad(biquadCoeffs(type, sampleRate, cutoffHz, q, gainDb)).process(buf);
    return;
  }
  const bq = new Biquad(biquadCoeffs(type, sampleRate, cutoffHz, q, gainDb));
  const block = 32;
  const n = buf.length;
  for (let start = 0; start < n; start += block) {
    const t = start / Math.max(1, n - 1);
    let f = sweep ? curveInterpFreq(cutoffHz, sweep.end_hz, t, sweep.curve) : cutoffHz;
    if (cutoffLfo) {
      f *= 1 + (cutoffLfo.depthPct / 100) * cutoffLfo.next(t, block / sampleRate);
    }
    bq.c = biquadCoeffs(type, sampleRate, f, q, gainDb);
    const end = Math.min(n, start + block);
    for (let i = start; i < end; i++) buf[i] = bq.processSample(buf[i]);
  }
}
