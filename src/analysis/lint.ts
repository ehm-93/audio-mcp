/**
 * Lint rules over the rendered audio and its analysis bundle. Render and
 * export both attach findings so defects surface without a separate call.
 */

import { AudioBuf } from "../dsp/buffer.js";
import { Recipe, Project } from "../schema.js";
import { AnalysisBundle, AnalysisExtras } from "./bundle.js";

export type LintSeverity = "error" | "warn";

export interface LintFinding {
  code: string;
  severity: LintSeverity;
  message: string;
}

const CLICK_ABS_THRESHOLD = 0.25; // linear step treated as a click candidate
const CLICK_CONTEXT_RATIO = 8; // interior step must also stand this far above local diff RMS
const LOOP_SEAM_THRESHOLD_DB = -26;

/**
 * Click detection: boundary steps from/to silence over the absolute
 * threshold, and interior single-sample steps that are both large and far
 * above the local diff RMS (so periodic edges like square waves don't flag).
 */
function findClicks(buf: AudioBuf, loopEnabled: boolean): string[] {
  const found: string[] = [];
  const sr = buf.sampleRate;
  const contextWin = Math.round(0.005 * sr);

  for (let c = 0; c < buf.channels.length; c++) {
    const ch = buf.channels[c];
    const n = ch.length;
    if (n < 2) continue;

    if (Math.abs(ch[0]) > CLICK_ABS_THRESHOLD) {
      found.push(`start: signal begins at ${ch[0].toFixed(2)} instead of near zero`);
    }
    if (!loopEnabled && Math.abs(ch[n - 1]) > CLICK_ABS_THRESHOLD) {
      found.push(`end: signal ends at ${ch[n - 1].toFixed(2)} instead of near zero`);
    }

    // interior: compare each diff against local diff RMS
    let worst = 0;
    let worstAt = -1;
    let sumSq = 0;
    const half = contextWin;
    // initial window
    for (let i = 1; i < Math.min(n, 2 * half); i++) {
      const d = ch[i] - ch[i - 1];
      sumSq += d * d;
    }
    let count = Math.min(n - 1, 2 * half - 1);
    for (let i = 1; i < n; i++) {
      // maintain sliding sum over [i-half, i+half]
      const addIdx = i + half;
      const dropIdx = i - half;
      if (addIdx < n) {
        const d = ch[addIdx] - ch[addIdx - 1];
        sumSq += d * d;
        count++;
      }
      if (dropIdx >= 1) {
        const d = ch[dropIdx] - ch[dropIdx - 1];
        sumSq -= d * d;
        count--;
      }
      const diff = Math.abs(ch[i] - ch[i - 1]);
      const localRms = Math.sqrt(Math.max(sumSq, 0) / Math.max(count, 1));
      if (diff > CLICK_ABS_THRESHOLD && diff > localRms * CLICK_CONTEXT_RATIO && diff > worst) {
        worst = diff;
        worstAt = i;
      }
    }
    if (worstAt > 0) {
      found.push(`interior: step of ${worst.toFixed(2)} at ${((worstAt / sr) * 1000).toFixed(1)} ms`);
    }
    break; // one channel is enough to report; stereo clicks repeat the message
  }
  return found;
}

export interface LintContext {
  recipe?: Recipe;
  project: Project;
  /** export-time check: target is mono while the recipe is stereo */
  exportToMono?: boolean;
}

export function lint(buf: AudioBuf, bundle: AnalysisBundle, extras: AnalysisExtras, ctx: LintContext): LintFinding[] {
  const findings: LintFinding[] = [];
  const loopEnabled = ctx.recipe?.loop.enabled ?? false;

  if (bundle.true_peak_dbtp > -0.3) {
    findings.push({
      code: "E101",
      severity: "error",
      message: `true peak ${bundle.true_peak_dbtp} dBTP exceeds -0.3 dBTP; reduce master or layer gain`,
    });
  }

  if (bundle.dc_offset_db > -60) {
    findings.push({
      code: "E102",
      severity: "error",
      message: `DC offset ${bundle.dc_offset_db} dBFS exceeds -60 dBFS; add a highpass filter`,
    });
  }

  for (const click of findClicks(buf, loopEnabled)) {
    findings.push({ code: "E103", severity: "error", message: `click at ${click}` });
  }

  if (loopEnabled && bundle.loop_seam_db !== null && bundle.loop_seam_db > LOOP_SEAM_THRESHOLD_DB) {
    findings.push({
      code: "E104",
      severity: "error",
      message: `loop seam discontinuity ${bundle.loop_seam_db} dB exceeds ${LOOP_SEAM_THRESHOLD_DB} dB; lengthen crossfade_ms`,
    });
  }

  if (extras.energyBelow30Db > -40) {
    findings.push({
      code: "W201",
      severity: "warn",
      message: `energy below 30 Hz is ${Math.round(extras.energyBelow30Db * 10) / 10} dBFS (above -40); likely inaudible rumble, highpass it`,
    });
  }

  if (!loopEnabled && bundle.tail_silence_ms > 250) {
    findings.push({
      code: "W202",
      severity: "warn",
      message: `silent tail of ${bundle.tail_silence_ms} ms; reduce duration_ms to about ${Math.ceil(bundle.duration_ms - bundle.tail_silence_ms + 50)} ms`,
    });
  }

  for (const layer of bundle.layers) {
    if (layer.masked_above_ms === 0) {
      findings.push({
        code: "W203",
        severity: "warn",
        message: `layer "${layer.id}" is masked by the rest of the mix for its entire duration`,
      });
    }
  }

  const recipeStereo = (ctx.recipe?.channels ?? ctx.project.channels_default) === "stereo";
  if (recipeStereo && ctx.exportToMono) {
    findings.push({
      code: "W204",
      severity: "warn",
      message: "stereo recipe exported to a mono target; channels will be summed",
    });
  }

  const loudness = ctx.project.loudness;
  if (loudness.mode === "lufs" && loudness.lufs_target !== null && bundle.lufs_integrated > -119) {
    const delta = bundle.lufs_integrated - loudness.lufs_target;
    if (Math.abs(delta) > 6) {
      findings.push({
        code: "W205",
        severity: "warn",
        message: `loudness ${bundle.lufs_integrated} LUFS is ${Math.round(delta * 10) / 10} dB from the project target ${loudness.lufs_target} LUFS`,
      });
    }
  } else if (loudness.mode === "peak") {
    const delta = bundle.peak_dbfs - loudness.peak_db;
    if (Math.abs(delta) > 6) {
      findings.push({
        code: "W205",
        severity: "warn",
        message: `peak ${bundle.peak_dbfs} dBFS is ${Math.round(delta * 10) / 10} dB from the project target ${loudness.peak_db} dBFS`,
      });
    }
  }

  return findings;
}

const ENV_TRUNCATION_FLOOR_DB = -70;
const ENV_TRUNCATION_MARGIN_DB = 20;

/** W206 needs per-layer buffers, so it runs separately where they are available. */
export function lintEnvelopeTruncation(layers: { id: string; buf: AudioBuf }[], loopEnabled: boolean): LintFinding[] {
  if (loopEnabled) return [];
  const findings: LintFinding[] = [];
  for (const { id, buf } of layers) {
    const n = buf.channels[0].length;
    const win = Math.min(n, Math.round(0.005 * buf.sampleRate));
    let sum = 0;
    let count = 0;
    for (const ch of buf.channels) {
      for (let i = n - win; i < n; i++) sum += ch[i] * ch[i];
      count += win;
    }
    const rmsDb = count === 0 ? -Infinity : 20 * Math.log10(Math.max(Math.sqrt(sum / count), 1e-9));
    if (rmsDb > ENV_TRUNCATION_FLOOR_DB + ENV_TRUNCATION_MARGIN_DB) {
      findings.push({
        code: "W206",
        severity: "warn",
        message: `layer "${id}" is cut off at ${Math.round(rmsDb)} dBFS at duration_ms; extend duration_ms or shorten the envelope`,
      });
    }
  }
  return findings;
}

export function worstSeverity(findings: LintFinding[]): LintSeverity | "clean" {
  if (findings.some((f) => f.severity === "error")) return "error";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "clean";
}
