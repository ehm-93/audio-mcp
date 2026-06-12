/** Internal audio representation: float32 planar channels at one sample rate. */

export interface AudioBuf {
  sampleRate: number;
  /** 1 (mono) or 2 (stereo) Float32Arrays of equal length. */
  channels: Float32Array[];
}

export function createBuf(sampleRate: number, numChannels: number, length: number): AudioBuf {
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(length));
  return { sampleRate, channels };
}

export function bufLength(buf: AudioBuf): number {
  return buf.channels[0]?.length ?? 0;
}

export function toMono(buf: AudioBuf): AudioBuf {
  if (buf.channels.length === 1) return buf;
  const n = bufLength(buf);
  const out = new Float32Array(n);
  const scale = 1 / buf.channels.length;
  for (const ch of buf.channels) {
    for (let i = 0; i < n; i++) out[i] += ch[i] * scale;
  }
  return { sampleRate: buf.sampleRate, channels: [out] };
}

export function toStereo(buf: AudioBuf): AudioBuf {
  if (buf.channels.length === 2) return buf;
  return { sampleRate: buf.sampleRate, channels: [buf.channels[0], buf.channels[0].slice()] };
}

export function matchChannels(buf: AudioBuf, numChannels: number): AudioBuf {
  return numChannels === 1 ? toMono(buf) : toStereo(buf);
}

export function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

export function linToDb(lin: number): number {
  return lin <= 0 ? -Infinity : 20 * Math.log10(lin);
}

/** Mix src into dst starting at dstOffset, clipping to dst bounds. */
export function mixInto(dst: Float32Array, src: Float32Array, dstOffset: number, gain = 1): void {
  const start = Math.max(0, dstOffset);
  const end = Math.min(dst.length, dstOffset + src.length);
  for (let i = start; i < end; i++) dst[i] += src[i - dstOffset] * gain;
}
