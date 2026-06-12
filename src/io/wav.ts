/** Pure-JS WAV read/write. Reads PCM 16/24/32 and float32/64; writes float32 or PCM16. */

import { AudioBuf } from "../dsp/buffer.js";

export function decodeWav(data: Uint8Array): AudioBuf {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, false) !== 0x52494646 /* RIFF */ || view.getUint32(8, false) !== 0x57415645 /* WAVE */) {
    throw new Error("not a RIFF/WAVE file");
  }
  let pos = 12;
  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  while (pos + 8 <= view.byteLength) {
    const id = view.getUint32(pos, false);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 0x666d7420 /* fmt  */) {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (format === 0xfffe /* extensible */ && size >= 40) {
        format = view.getUint16(body + 24, true); // first 2 bytes of SubFormat GUID
      }
    } else if (id === 0x64617461 /* data */) {
      dataOffset = body;
      dataLength = Math.min(size, view.byteLength - body);
    }
    pos = body + size + (size & 1);
  }
  if (dataOffset < 0 || !numChannels || !sampleRate) throw new Error("missing fmt or data chunk");

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * numChannels));
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const off = dataOffset + (i * numChannels + c) * bytesPerSample;
      let v: number;
      if (format === 3 && bitsPerSample === 32) v = view.getFloat32(off, true);
      else if (format === 3 && bitsPerSample === 64) v = view.getFloat64(off, true);
      else if (bitsPerSample === 16) v = view.getInt16(off, true) / 32768;
      else if (bitsPerSample === 24) {
        const b0 = view.getUint8(off), b1 = view.getUint8(off + 1), b2 = view.getUint8(off + 2);
        let s = (b2 << 16) | (b1 << 8) | b0;
        if (s & 0x800000) s |= ~0xffffff;
        v = s / 8388608;
      } else if (bitsPerSample === 32) v = view.getInt32(off, true) / 2147483648;
      else if (bitsPerSample === 8) v = (view.getUint8(off) - 128) / 128;
      else throw new Error(`unsupported wav: format ${format}, ${bitsPerSample} bits`);
      channels[c][i] = v;
    }
  }
  return { sampleRate, channels };
}

export function encodeWav(buf: AudioBuf, encoding: "float32" | "pcm16" = "float32"): Uint8Array {
  const numChannels = buf.channels.length;
  const frames = buf.channels[0].length;
  const bytesPerSample = encoding === "float32" ? 4 : 2;
  const dataSize = frames * numChannels * bytesPerSample;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  view.setUint32(0, 0x52494646, false); // RIFF
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false); // WAVE
  view.setUint32(12, 0x666d7420, false); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, encoding === "float32" ? 3 : 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  view.setUint32(36, 0x64617461, false); // data
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = buf.channels[c][i];
      if (encoding === "float32") {
        view.setFloat32(off, v, true);
        off += 4;
      } else {
        const clamped = Math.max(-1, Math.min(1, v));
        view.setInt16(off, Math.round(clamped * 32767), true);
        off += 2;
      }
    }
  }
  return out;
}
