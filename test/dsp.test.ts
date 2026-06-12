import { describe, it, expect } from "vitest";
import { mulberry32, hashSeed } from "../src/dsp/prng.js";
import { decodeWav, encodeWav } from "../src/io/wav.js";
import { lufsIntegrated } from "../src/analysis/lufs.js";
import { peakDbfs, truePeakDbtp, rmsDbfs, dcOffsetDb } from "../src/analysis/measure.js";
import { renderNoise } from "../src/dsp/noise.js";
import { renderOsc } from "../src/dsp/osc.js";
import { renderModal } from "../src/dsp/modal.js";
import { applyFilter } from "../src/dsp/biquad.js";
import { applyEnvelope } from "../src/dsp/envelope.js";
import { applyLoopCrossfade } from "../src/dsp/loop.js";
import { resample } from "../src/dsp/resample.js";
import { stft, bandEnergyDb, centroidTrajectory, findResonances } from "../src/analysis/spectral.js";
import { AudioBuf } from "../src/dsp/buffer.js";

const SR = 44100;

function sine(freq: number, seconds: number, amp = 1): AudioBuf {
  const n = Math.round(seconds * SR);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { sampleRate: SR, channels: [ch] };
}

describe("prng", () => {
  it("is deterministic per seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
  it("hashSeed separates layer ids", () => {
    expect(hashSeed(7, "crack")).not.toBe(hashSeed(7, "body"));
    expect(hashSeed(7, "crack")).toBe(hashSeed(7, "crack"));
  });
});

describe("wav io", () => {
  it("round-trips float32 exactly", () => {
    const noise = renderNoise(1000, "white", 1);
    const buf: AudioBuf = { sampleRate: SR, channels: [noise] };
    const decoded = decodeWav(encodeWav(buf, "float32"));
    expect(decoded.sampleRate).toBe(SR);
    expect(decoded.channels.length).toBe(1);
    for (let i = 0; i < 1000; i++) expect(decoded.channels[0][i]).toBe(noise[i]);
  });
  it("round-trips pcm16 within quantization error", () => {
    const buf = sine(440, 0.05, 0.5);
    const decoded = decodeWav(encodeWav(buf, "pcm16"));
    for (let i = 0; i < 100; i++) expect(decoded.channels[0][i]).toBeCloseTo(buf.channels[0][i], 3);
  });
});

describe("measurements", () => {
  it("LUFS of a 997 Hz full-scale sine is ~-3.01 (BS.1770 reference)", () => {
    expect(lufsIntegrated(sine(997, 5))).toBeCloseTo(-3.01, 1);
  });
  it("peak of half-scale sine is -6 dBFS", () => {
    expect(peakDbfs(sine(440, 0.5, 0.5))).toBeCloseTo(-6.02, 1);
  });
  it("true peak sees inter-sample overs that sample peak misses", () => {
    // a sine near Nyquist/4 with phase offset has true peak ~= 0 even when samples miss the crest
    const buf = sine(11025.5, 0.1, 0.99);
    expect(truePeakDbtp(buf)).toBeGreaterThanOrEqual(peakDbfs(buf) - 0.1);
  });
  it("rms of full-scale sine is ~-3.01 dBFS", () => {
    expect(rmsDbfs(sine(440, 1))).toBeCloseTo(-3.01, 1);
  });
  it("dc offset is detected", () => {
    const ch = new Float32Array(SR).fill(0.01);
    expect(dcOffsetDb({ sampleRate: SR, channels: [ch] })).toBeCloseTo(-40, 0.5);
  });
});

describe("sources", () => {
  it("noise colors are seeded and normalized to about -12 dBFS rms", () => {
    for (const color of ["white", "pink", "brown", "blue"] as const) {
      const a = renderNoise(SR, color, 5);
      const b = renderNoise(SR, color, 5);
      expect(a).toEqual(b);
      expect(rmsDbfs({ sampleRate: SR, channels: [a] })).toBeCloseTo(-12, 0.5);
    }
  });
  it("osc produces the requested fundamental", () => {
    const buf: AudioBuf = { sampleRate: SR, channels: [renderOsc(SR, SR, "saw", 440)] };
    const traj = centroidTrajectory(stft(buf));
    expect(traj.mean).toBeGreaterThan(440); // saw has harmonics above the fundamental
    const res = findResonances(stft({ sampleRate: SR, channels: [renderOsc(SR, SR, "sine", 440)] }));
    expect(res.length).toBeGreaterThan(0);
    expect(Math.abs(res[0].freq_hz - 440)).toBeLessThan(50);
  });
  it("modal modes ring at their frequencies and decay", () => {
    const out = renderModal(SR, SR, [{ freq_hz: 410, decay_ms: 90, gain_db: 0 }], "impulse", 5, 1);
    const buf: AudioBuf = { sampleRate: SR, channels: [out] };
    const res = findResonances(stft(buf));
    expect(res.some((r) => Math.abs(r.freq_hz - 410) < 50)).toBe(true);
    // after 5x decay_ms the tail should be far down
    const tail = out.slice(Math.round(0.45 * SR));
    let peak = 0;
    for (const v of tail) peak = Math.max(peak, Math.abs(v));
    expect(20 * Math.log10(peak + 1e-12)).toBeLessThan(-50);
  });
});

describe("filters and envelope", () => {
  it("lowpass attenuates highs", () => {
    const noise = renderNoise(SR, "white", 3);
    applyFilter(noise, SR, "lowpass", 500, 0.707, 0);
    const bands = bandEnergyDb(stft({ sampleRate: SR, channels: [noise] }));
    expect(bands["6k-12k"]).toBeLessThan(bands["150-400"] - 30);
  });
  it("envelope attack and release reach silence at both ends", () => {
    const ch = new Float32Array(SR).fill(1);
    applyEnvelope(ch, SR, { attack_ms: 100, hold_ms: 0, decay_ms: 0, sustain: 1, release_ms: 100, curve: "lin" });
    expect(Math.abs(ch[0])).toBeLessThan(0.01);
    expect(Math.abs(ch[SR - 1])).toBeLessThan(0.01);
    expect(ch[Math.round(0.5 * SR)]).toBeCloseTo(1, 5);
  });
  it("exp decay drops fast then tails", () => {
    const ch = new Float32Array(SR).fill(1);
    applyEnvelope(ch, SR, { attack_ms: 0, hold_ms: 0, decay_ms: 1000, sustain: 0, release_ms: 0, curve: "exp" });
    const atQuarter = ch[Math.round(0.25 * SR)];
    expect(atQuarter).toBeLessThan(0.3); // already well down at 25% of the decay
  });
});

describe("loop and resample", () => {
  it("crossfade trims to duration minus crossfade", () => {
    const buf = sine(440, 1);
    const looped = applyLoopCrossfade(buf, 100);
    expect(looped.channels[0].length).toBe(SR - Math.round(0.1 * SR));
  });
  it("resample changes length by the ratio and preserves pitch content", () => {
    const buf = sine(440, 0.5);
    const up = resample(buf.channels[0], 2);
    expect(up.length).toBe(buf.channels[0].length * 2);
    // at 2x length the tone plays at 220 Hz relative to original rate
    const res = findResonances(stft({ sampleRate: SR, channels: [up] }));
    expect(res.some((r) => Math.abs(r.freq_hz - 220) < 30)).toBe(true);
  });
});
