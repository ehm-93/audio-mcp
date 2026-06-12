/**
 * Windowed-sinc interpolation used for pitch shift (varispeed), sample-rate
 * conversion of imported refs, and granular pitch jitter.
 */

const TAPS = 16; // taps per side
const KAISER_BETA = 8;

function bessi0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 25; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

const KAISER_NORM = bessi0(KAISER_BETA);

function kaiser(t: number): number {
  // t in -1..1
  const arg = 1 - t * t;
  if (arg <= 0) return 0;
  return bessi0(KAISER_BETA * Math.sqrt(arg)) / KAISER_NORM;
}

/** Read input at fractional position with windowed-sinc interpolation. `cutoff` <1 band-limits for downward resampling. */
function sincRead(input: Float32Array, pos: number, cutoff: number): number {
  const center = Math.floor(pos);
  const frac = pos - center;
  let sum = 0;
  for (let k = -TAPS + 1; k <= TAPS; k++) {
    const idx = center + k;
    if (idx < 0 || idx >= input.length) continue;
    const x = (k - frac) * cutoff;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = kaiser((k - frac) / TAPS);
    sum += input[idx] * sinc * w * cutoff;
  }
  return sum;
}

/**
 * Resample by `ratio` (output rate / input rate). ratio > 1 means more output
 * samples (slower/lower if treated as varispeed pitch-down).
 */
export function resample(input: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-9) return input.slice();
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const step = 1 / ratio;
  const cutoff = Math.min(1, ratio); // band-limit when decimating
  for (let i = 0; i < outLen; i++) {
    out[i] = sincRead(input, i * step, cutoff);
  }
  return out;
}

/** Varispeed pitch shift: positive semitones raise pitch and shorten the signal. */
export function pitchShift(input: Float32Array, semitones: number): Float32Array {
  if (Math.abs(semitones) < 1e-6) return input;
  const speed = Math.pow(2, semitones / 12);
  return resample(input, 1 / speed);
}

/**
 * Time-varying sample playback. Reads `input` into a buffer of `outLength`
 * samples, advancing the read head by `rate * 2^(semitonesAt(t)/12)` per output
 * sample (t is normalized 0..1 over the output). Output past the end of the
 * input stays zero. At rate 1 with a zero envelope this is a bit-exact copy
 * (sinc at integer offsets collapses to the identity), so a plain sample is
 * unchanged. Band-limits on the fly when playing faster than 1x.
 */
export function varispeed(
  input: Float32Array,
  outLength: number,
  rate: number,
  semitonesAt: (t: number) => number,
): Float32Array {
  const out = new Float32Array(outLength);
  let pos = 0;
  for (let i = 0; i < outLength; i++) {
    if (pos >= input.length) break; // remainder stays zero
    const t = outLength <= 1 ? 0 : i / (outLength - 1);
    const speed = rate * Math.pow(2, semitonesAt(t) / 12);
    out[i] = sincRead(input, pos, Math.min(1, 1 / speed));
    pos += speed;
  }
  return out;
}
