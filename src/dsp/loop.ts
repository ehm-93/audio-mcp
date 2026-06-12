/**
 * Loop preparation: equal-power crossfade of the tail into the head, then
 * trim to the loop length (duration minus crossfade).
 */

import { AudioBuf } from "./buffer.js";

export function applyLoopCrossfade(buf: AudioBuf, crossfadeMs: number): AudioBuf {
  const n = buf.channels[0].length;
  const fade = Math.min(Math.floor(n / 2), Math.max(1, Math.round((crossfadeMs / 1000) * buf.sampleRate)));
  const outLen = n - fade;
  const channels = buf.channels.map((ch) => {
    const out = new Float32Array(outLen);
    out.set(ch.subarray(0, outLen));
    for (let i = 0; i < fade; i++) {
      const t = (i + 1) / (fade + 1);
      const inGain = Math.sin((t * Math.PI) / 2);
      const outGain = Math.cos((t * Math.PI) / 2);
      out[i] = ch[i] * inGain + ch[outLen + i] * outGain;
    }
    return out;
  });
  return { sampleRate: buf.sampleRate, channels };
}

/** Worst inter-sample step across the seam (end wrapping to start), in dB. */
export function measureLoopSeam(buf: AudioBuf): number {
  let worst = 0;
  for (const ch of buf.channels) {
    const step = Math.abs(ch[0] - ch[ch.length - 1]);
    worst = Math.max(worst, step);
  }
  return worst <= 0 ? -Infinity : 20 * Math.log10(worst);
}
