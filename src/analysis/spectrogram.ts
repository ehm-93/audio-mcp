/**
 * PNG rendering. Conventions are fixed so images stay comparable between
 * turns: log frequency 20 Hz..20 kHz, dB pinned 0..-80 dBFS, one colormap,
 * time in ms, 880x440 spectrograms. Brightness is never auto-scaled.
 */

import { createCanvas, SKRSContext2D } from "@napi-rs/canvas";
import { AudioBuf, toMono } from "../dsp/buffer.js";
import { Stft } from "./spectral.js";

export const IMG_W = 880;
export const IMG_H = 440;
const MARGIN_L = 56;
const MARGIN_B = 28;
const MARGIN_T = 20;
const MARGIN_R = 12;

const F_MIN = 20;
const F_MAX = 20000;
const DB_MIN = -80;

// viridis approximation
const STOPS: [number, number, number, number][] = [
  [0.0, 68, 1, 84],
  [0.25, 59, 82, 139],
  [0.5, 33, 145, 140],
  [0.75, 94, 201, 98],
  [1.0, 253, 231, 37],
];

function colormap(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0]) {
      const [t0, r0, g0, b0] = STOPS[i - 1];
      const [t1, r1, g1, b1] = STOPS[i];
      const f = (x - t0) / (t1 - t0);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  return [253, 231, 37];
}

function niceTimeStep(totalMs: number): number {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  for (const s of steps) {
    if (totalMs / s <= 8) return s;
  }
  return 10000;
}

const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

function freqLabel(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : String(f);
}

/**
 * Draw one spectrogram panel into ctx at (x0, y0) with plot size w x h.
 * soundMs is this sound's length; axisMs the time axis span (>= soundMs when
 * sharing axes in compare), with the region past the sound left at -80 dB.
 */
function drawSpectrogramPanel(
  ctx: SKRSContext2D,
  s: Stft,
  x0: number,
  y0: number,
  w: number,
  h: number,
  title: string,
  soundMs: number,
  axisMs: number,
): void {
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const numFrames = s.frames.length;
  const numBins = s.frames[0].length;
  const logRatio = Math.log(F_MAX / F_MIN);
  const [bgR, bgG, bgB] = colormap(0);

  for (let px = 0; px < w; px++) {
    const tMs0 = (px / w) * axisMs;
    const tMs1 = ((px + 1) / w) * axisMs;
    if (tMs0 >= soundMs) {
      for (let py = 0; py < h; py++) {
        const idx = (py * w + px) * 4;
        data[idx] = bgR;
        data[idx + 1] = bgG;
        data[idx + 2] = bgB;
        data[idx + 3] = 255;
      }
      continue;
    }
    // average all frames covered by this pixel column
    const f0 = Math.max(0, Math.min(numFrames - 1, Math.floor((tMs0 / soundMs) * numFrames)));
    const f1 = Math.max(f0 + 1, Math.min(numFrames, Math.ceil((tMs1 / soundMs) * numFrames)));

    for (let py = 0; py < h; py++) {
      // top of panel = F_MAX
      const frac = 1 - py / (h - 1);
      const freq = F_MIN * Math.exp(frac * logRatio);
      const freqNext = F_MIN * Math.exp(Math.min(1, frac + 1 / (h - 1)) * logRatio);
      const binLo = Math.max(1, Math.floor(freq / s.binHz));
      const binHi = Math.min(numBins - 1, Math.max(binLo, Math.ceil(freqNext / s.binHz) - 1));

      let power = 0;
      let count = 0;
      for (let fr = f0; fr < f1; fr++) {
        const frame = s.frames[fr];
        if (binHi <= binLo) {
          // interpolate between bins when zoomed past bin resolution
          const exact = freq / s.binHz;
          const k = Math.max(1, Math.min(numBins - 2, Math.floor(exact)));
          const fpart = exact - k;
          power += frame[k] * (1 - fpart) + frame[k + 1] * fpart;
          count++;
        } else {
          for (let k = binLo; k <= binHi; k++) {
            power += frame[k];
            count++;
          }
        }
      }
      const p = count > 0 ? power / count : 0;
      const db = 10 * Math.log10(Math.max(p, 1e-12));
      const [r, g, b] = colormap((db - DB_MIN) / -DB_MIN);
      const idx = (py * w + px) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, x0, y0);

  // frame, gridlines, labels
  ctx.strokeStyle = "#888";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
  ctx.fillStyle = "#ddd";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const f of FREQ_TICKS) {
    const frac = Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN);
    const y = y0 + (1 - frac) * (h - 1);
    ctx.fillText(freqLabel(f), x0 - 4, y);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.moveTo(x0, y + 0.5);
    ctx.lineTo(x0 + w, y + 0.5);
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = niceTimeStep(axisMs);
  for (let t = 0; t <= axisMs + 1e-6; t += step) {
    const x = x0 + (t / axisMs) * (w - 1);
    ctx.fillText(String(Math.round(t)), x, y0 + h + 4);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y0);
    ctx.lineTo(x + 0.5, y0 + h);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.font = "12px sans-serif";
  ctx.fillText(title, x0, y0 - 4);
}

function newCanvas(w: number, h: number) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#16161e";
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

export async function renderSpectrogramPng(s: Stft, durationMs: number, title: string): Promise<Buffer> {
  const { canvas, ctx } = newCanvas(IMG_W, IMG_H);
  drawSpectrogramPanel(ctx, s, MARGIN_L, MARGIN_T, IMG_W - MARGIN_L - MARGIN_R, IMG_H - MARGIN_T - MARGIN_B, `${title} — spectrogram, dB 0..-80`, durationMs, durationMs);
  return canvas.encode("png");
}

export async function renderComparePng(
  a: { stft: Stft; durationMs: number; title: string },
  b: { stft: Stft; durationMs: number; title: string },
): Promise<Buffer> {
  const { canvas, ctx } = newCanvas(IMG_W, IMG_H * 2);
  const w = IMG_W - MARGIN_L - MARGIN_R;
  const h = IMG_H - MARGIN_T - MARGIN_B;
  const totalMs = Math.max(a.durationMs, b.durationMs); // identical time axes
  drawSpectrogramPanel(ctx, a.stft, MARGIN_L, MARGIN_T, w, h, `A: ${a.title}`, a.durationMs, totalMs);
  drawSpectrogramPanel(ctx, b.stft, MARGIN_L, IMG_H + MARGIN_T, w, h, `B: ${b.title}`, b.durationMs, totalMs);
  return canvas.encode("png");
}

export async function renderVariantStripPng(
  variants: { stft: Stft; durationMs: number; title: string }[],
): Promise<Buffer> {
  const cellH = 150;
  const { canvas, ctx } = newCanvas(IMG_W, cellH * variants.length + 10);
  const w = IMG_W - MARGIN_L - MARGIN_R;
  const totalMs = Math.max(...variants.map((v) => v.durationMs));
  variants.forEach((v, i) => {
    drawSpectrogramPanel(ctx, v.stft, MARGIN_L, MARGIN_T + i * cellH, w, cellH - MARGIN_T - MARGIN_B, v.title, v.durationMs, totalMs);
  });
  return canvas.encode("png");
}

export async function renderWaveformPng(buf: AudioBuf, title: string): Promise<Buffer> {
  const H = 220;
  const { canvas, ctx } = newCanvas(IMG_W, H);
  const x0 = MARGIN_L;
  const y0 = MARGIN_T;
  const w = IMG_W - MARGIN_L - MARGIN_R;
  const h = H - MARGIN_T - MARGIN_B;
  const mono = toMono(buf).channels[0];
  const n = mono.length;
  const totalMs = (n / buf.sampleRate) * 1000;

  ctx.fillStyle = "#0c0c12";
  ctx.fillRect(x0, y0, w, h);

  // fixed -1..1 amplitude scale
  ctx.fillStyle = "#4fc3f7";
  for (let px = 0; px < w; px++) {
    const i0 = Math.floor((px / w) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((px + 1) / w) * n));
    let lo = 0;
    let hi = 0;
    for (let i = i0; i < i1 && i < n; i++) {
      lo = Math.min(lo, mono[i]);
      hi = Math.max(hi, mono[i]);
    }
    const yHi = y0 + ((1 - hi) / 2) * h;
    const yLo = y0 + ((1 - lo) / 2) * h;
    ctx.fillRect(x0 + px, yHi, 1, Math.max(1, yLo - yHi));
  }

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.moveTo(x0, y0 + h / 2 + 0.5);
  ctx.lineTo(x0 + w, y0 + h / 2 + 0.5);
  ctx.stroke();
  ctx.strokeStyle = "#888";
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);

  ctx.fillStyle = "#ddd";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const a of [1, 0.5, 0, -0.5, -1]) {
    ctx.fillText(a.toFixed(1), x0 - 4, y0 + ((1 - a) / 2) * h);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const stepMs = niceTimeStep(totalMs);
  for (let t = 0; t <= totalMs + 1e-6; t += stepMs) {
    ctx.fillText(String(Math.round(t)), x0 + (t / totalMs) * (w - 1), y0 + h + 4);
  }
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.font = "12px sans-serif";
  ctx.fillText(`${title} — waveform, amplitude -1..1`, x0, y0 - 4);
  return canvas.encode("png");
}
