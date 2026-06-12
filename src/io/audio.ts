/**
 * Audio file decode (wav, ogg vorbis, flac — all without ffmpeg) and ogg
 * vorbis encode via wasm-media-encoders.
 */

import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import { FLACDecoder } from "@wasm-audio-decoders/flac";
import { createOggEncoder } from "wasm-media-encoders";
import { AudioBuf } from "../dsp/buffer.js";
import { decodeWav } from "./wav.js";
import { resample } from "../dsp/resample.js";

export const DECODABLE_EXTENSIONS = [".wav", ".ogg", ".flac"];

export async function decodeAudio(data: Uint8Array, ext: string): Promise<AudioBuf> {
  const e = ext.toLowerCase();
  if (e === ".wav") return decodeWav(data);

  if (e === ".ogg") {
    const decoder = new OggVorbisDecoder();
    try {
      await decoder.ready;
      const result = await decoder.decodeFile(data);
      if (!result.channelData?.length) throw new Error("ogg decode produced no audio");
      return { sampleRate: result.sampleRate, channels: result.channelData.map((c: Float32Array) => Float32Array.from(c)) };
    } finally {
      decoder.free();
    }
  }

  if (e === ".flac") {
    const decoder = new FLACDecoder();
    try {
      await decoder.ready;
      const result = await decoder.decodeFile(data);
      if (!result.channelData?.length) throw new Error("flac decode produced no audio");
      return { sampleRate: result.sampleRate, channels: result.channelData.map((c: Float32Array) => Float32Array.from(c)) };
    } finally {
      decoder.free();
    }
  }

  throw new Error(`unsupported audio extension "${ext}"; supported: ${DECODABLE_EXTENSIONS.join(", ")}`);
}

export function resampleTo(buf: AudioBuf, targetRate: number): AudioBuf {
  if (buf.sampleRate === targetRate) return buf;
  const ratio = targetRate / buf.sampleRate;
  return { sampleRate: targetRate, channels: buf.channels.map((ch) => resample(ch, ratio)) };
}

export async function encodeOgg(buf: AudioBuf, vbrQuality = 3): Promise<Uint8Array> {
  const encoder = await createOggEncoder();
  encoder.configure({
    channels: buf.channels.length as 1 | 2,
    sampleRate: buf.sampleRate,
    vbrQuality,
  });
  const chunks: Uint8Array[] = [];
  // returned views alias wasm memory and are invalidated by the next call: copy
  chunks.push(Uint8Array.from(encoder.encode(buf.channels as [Float32Array] | [Float32Array, Float32Array])));
  chunks.push(Uint8Array.from(encoder.finalize()));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
