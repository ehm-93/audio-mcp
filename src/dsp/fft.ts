/** Thin wrapper over fft.js for real-signal forward/inverse transforms. */

import FFT from "fft.js";

const cache = new Map<number, FFT>();

function get(size: number): FFT {
  let f = cache.get(size);
  if (!f) {
    f = new FFT(size);
    cache.set(size, f);
  }
  return f;
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Forward real FFT. Input length must be `size` (pad beforehand). Returns interleaved complex, length 2*size. */
export function rfft(input: Float32Array | Float64Array, size: number): Float64Array {
  const f = get(size);
  const out = f.createComplexArray() as number[];
  const inp = new Array(size).fill(0);
  for (let i = 0; i < Math.min(input.length, size); i++) inp[i] = input[i];
  f.realTransform(out, inp);
  f.completeSpectrum(out);
  return Float64Array.from(out);
}

/** Inverse FFT of interleaved complex (length 2*size); returns real part, length size. */
export function irfft(spectrum: Float64Array, size: number): Float64Array {
  const f = get(size);
  const out = f.createComplexArray() as number[];
  f.inverseTransform(out, Array.from(spectrum));
  const real = new Float64Array(size);
  for (let i = 0; i < size; i++) real[i] = out[2 * i];
  return real;
}

/** Power spectrum magnitude (linear) of a windowed frame, bins 0..size/2. */
export function magnitudes(frame: Float32Array | Float64Array, size: number): Float64Array {
  const spec = rfft(frame, size);
  const half = size / 2;
  const mags = new Float64Array(half + 1);
  for (let i = 0; i <= half; i++) {
    const re = spec[2 * i];
    const im = spec[2 * i + 1];
    mags[i] = Math.sqrt(re * re + im * im);
  }
  return mags;
}

export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return w;
}
