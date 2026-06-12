/**
 * Export: render (cached), apply project loudness and naming, encode to the
 * target format. Refuses on error-severity lint findings unless forced.
 */

import * as fs from "node:fs/promises";
import { AudioBuf, matchChannels, dbToLin } from "../dsp/buffer.js";
import { resampleTo, encodeOgg } from "../io/audio.js";
import { encodeWav } from "../io/wav.js";
import { peakDbfs, round1 } from "../analysis/measure.js";
import { lufsIntegrated } from "../analysis/lufs.js";
import { Project } from "../schema.js";
import { Renderer, RenderedSound, pad2 } from "./renderer.js";

export interface ExportTarget {
  format: "ogg" | "wav";
  channels?: "mono" | "stereo";
  sample_rate?: number;
}

export interface ManifestEntry {
  file: string;
  source: string;
  lufs: number;
  peak_db: number;
}

function applyNaming(template: string, name: string, nn: number | null): string {
  let out = template.replaceAll("{name}", name);
  if (out.includes("{nn}")) {
    out = out.replaceAll("{nn}", nn === null ? "00" : pad2(nn));
  } else if (nn !== null) {
    out = `${out}_${pad2(nn)}`;
  }
  return out;
}

export async function exportSound(
  renderer: Renderer,
  project: Project,
  sound: RenderedSound,
  name: string,
  variant: number | null,
  target: ExportTarget,
): Promise<ManifestEntry> {
  const targetChannels = (target.channels ?? project.channels_default) === "stereo" ? 2 : 1;
  const targetRate = target.sample_rate ?? project.sample_rate;

  let buf: AudioBuf = matchChannels(sound.mix, targetChannels);
  buf = resampleTo(buf, targetRate);

  // project loudness: normalize to peak or LUFS target
  let gainDb = 0;
  if (project.loudness.mode === "peak") {
    const peak = peakDbfs(buf);
    if (peak > -Infinity) gainDb = project.loudness.peak_db - peak;
  } else if (project.loudness.lufs_target !== null) {
    const lufs = lufsIntegrated(buf);
    if (lufs > -Infinity) gainDb = project.loudness.lufs_target - lufs;
  }
  if (gainDb !== 0) {
    const g = dbToLin(gainDb);
    buf = { sampleRate: buf.sampleRate, channels: buf.channels.map((ch) => ch.map((v) => v * g)) };
  }

  const baseName = applyNaming(project.naming, name, variant);
  const relFile = `exports/${baseName}.${target.format}`;
  const absFile = renderer.ws.resolve(relFile);
  const data = target.format === "ogg" ? await encodeOgg(buf) : encodeWav(buf, "pcm16");
  await fs.writeFile(absFile, data);

  return {
    file: relFile,
    source: variant === null ? name : `${name}#${variant}`,
    lufs: round1(lufsIntegrated(buf)),
    peak_db: round1(peakDbfs(buf)),
  };
}
