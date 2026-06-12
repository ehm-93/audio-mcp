/**
 * Integrated loudness per ITU-R BS.1770-4: K-weighting (parametric form so it
 * works at any sample rate), 400 ms blocks with 75% overlap, absolute gate at
 * -70 LUFS, relative gate at -10 LU.
 */

import { AudioBuf } from "../dsp/buffer.js";
import { Biquad, BiquadCoeffs } from "../dsp/biquad.js";

/**
 * K-weighting stage 1: shelving filter modelling head effects. Parametric
 * generalization of the BS.1770 48 kHz coefficients to any sample rate
 * (De Man 2013), accurate to ~0.01 dB against the reference filter.
 */
function kShelf(sr: number): BiquadCoeffs {
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const fc = 1681.974450955533;
  const K = Math.tan((Math.PI * fc) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

/** K-weighting stage 2: RLB high-pass. Per BS.1770 the b coefficients are not normalized. */
function kHighpass(sr: number): BiquadCoeffs {
  const Q = 0.5003270373238773;
  const fc = 38.13547087602444;
  const K = Math.tan((Math.PI * fc) / sr);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

export function lufsIntegrated(buf: AudioBuf): number {
  const sr = buf.sampleRate;
  const weighted = buf.channels.map((ch) => {
    const out = ch.slice();
    new Biquad(kShelf(sr)).process(out);
    new Biquad(kHighpass(sr)).process(out);
    return out;
  });

  const blockSize = Math.round(0.4 * sr);
  const hop = Math.round(0.1 * sr);
  const n = weighted[0].length;

  const blockLoudness: number[] = [];
  if (n < blockSize) {
    // shorter than one gating block: fall back to ungated loudness of the whole signal
    let ms = 0;
    for (const ch of weighted) {
      for (let i = 0; i < n; i++) ms += ch[i] * ch[i];
    }
    ms /= Math.max(1, n);
    return -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
  }

  for (let start = 0; start + blockSize <= n; start += hop) {
    let ms = 0;
    for (const ch of weighted) {
      let sum = 0;
      for (let i = start; i < start + blockSize; i++) sum += ch[i] * ch[i];
      ms += sum / blockSize; // channel weights are 1 for mono/stereo
    }
    blockLoudness.push(-0.691 + 10 * Math.log10(Math.max(ms, 1e-12)));
  }

  const aboveAbsolute = blockLoudness.filter((l) => l > -70);
  if (aboveAbsolute.length === 0) return -Infinity;

  const meanEnergy = (blocks: number[]) =>
    blocks.reduce((acc, l) => acc + Math.pow(10, (l + 0.691) / 10), 0) / blocks.length;

  const relativeGate = -0.691 + 10 * Math.log10(meanEnergy(aboveAbsolute)) - 10;
  const gated = blockLoudness.filter((l) => l > -70 && l > relativeGate);
  if (gated.length === 0) return -Infinity;
  return -0.691 + 10 * Math.log10(meanEnergy(gated));
}
