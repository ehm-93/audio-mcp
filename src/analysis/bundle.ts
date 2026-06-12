/** Assembles the analysis bundle returned by render, compare, and import_reference. */

import { AudioBuf } from "../dsp/buffer.js";
import { RenderResult, ENGINE_VERSION } from "../dsp/engine.js";
import { measureLoopSeam } from "../dsp/loop.js";
import { peakDbfs, truePeakDbtp, rmsDbfs, dcOffsetDb, timingStats, rmsEnvelopeDb, round1 } from "./measure.js";
import { lufsIntegrated } from "./lufs.js";
import { stft, centroidTrajectory, bandEnergyDb, findResonances, energyBelowDb, Stft, CentroidTrajectory, Resonance } from "./spectral.js";

export interface LayerStats {
  id: string;
  peak_dbfs: number;
  /** Time after which the layer never rises within 25 dB of the mix; null = audible throughout. */
  masked_above_ms: number | null;
}

export interface AnalysisBundle {
  engine_version: string;
  file: string;
  duration_ms: number;
  channels: number;
  peak_dbfs: number;
  true_peak_dbtp: number;
  rms_dbfs: number;
  lufs_integrated: number;
  dc_offset_db: number;
  attack_ms: number;
  decay_to_minus40_ms: number | null;
  tail_silence_ms: number;
  spectral_centroid_hz: CentroidTrajectory;
  band_energy_db: Record<string, number>;
  resonances: Resonance[];
  layers: LayerStats[];
  loop_seam_db: number | null;
}

const MASK_THRESHOLD_DB = 25;

function layerMasking(mix: AudioBuf, layer: AudioBuf): { peak: number; maskedAboveMs: number | null } {
  const mixEnv = rmsEnvelopeDb(mix);
  const layerEnv = rmsEnvelopeDb(layer);
  const frames = Math.min(mixEnv.db.length, layerEnv.db.length);

  let lastAudible = -1;
  for (let f = 0; f < frames; f++) {
    if (layerEnv.db[f] > -80 && layerEnv.db[f] >= mixEnv.db[f] - MASK_THRESHOLD_DB) {
      lastAudible = f;
    }
  }
  let maskedAboveMs: number | null;
  if (lastAudible >= frames - 2) maskedAboveMs = null; // audible to the end
  else if (lastAudible < 0) maskedAboveMs = 0; // never audible
  else maskedAboveMs = round1(layerEnv.times_ms[lastAudible]);

  return { peak: round1(peakDbfs(layer)), maskedAboveMs };
}

export interface AnalyzeOptions {
  file: string;
  loopEnabled?: boolean;
  layers?: RenderResult["layers"];
}

export interface AnalysisExtras {
  /** STFT reused by the spectrogram renderer to avoid recomputation. */
  stft: Stft;
  energyBelow30Db: number;
}

export function analyze(mix: AudioBuf, opts: AnalyzeOptions): { bundle: AnalysisBundle; extras: AnalysisExtras } {
  const s = stft(mix);
  const timing = timingStats(mix);
  const r1 = (x: number) => (x === -Infinity ? -120 : round1(x));

  const layers: LayerStats[] = (opts.layers ?? []).map((l) => {
    const { peak, maskedAboveMs } = layerMasking(mix, l.buf);
    return { id: l.id, peak_dbfs: peak === -Infinity ? -120 : peak, masked_above_ms: maskedAboveMs };
  });

  const bundle: AnalysisBundle = {
    engine_version: ENGINE_VERSION,
    file: opts.file,
    duration_ms: round1((mix.channels[0].length / mix.sampleRate) * 1000),
    channels: mix.channels.length,
    peak_dbfs: r1(peakDbfs(mix)),
    true_peak_dbtp: r1(truePeakDbtp(mix)),
    rms_dbfs: r1(rmsDbfs(mix)),
    lufs_integrated: r1(lufsIntegrated(mix)),
    dc_offset_db: r1(dcOffsetDb(mix)),
    ...timing,
    spectral_centroid_hz: centroidTrajectory(s),
    band_energy_db: bandEnergyDb(s),
    resonances: findResonances(s),
    layers,
    loop_seam_db: opts.loopEnabled ? round1(measureLoopSeam(mix)) : null,
  };

  return { bundle, extras: { stft: s, energyBelow30Db: energyBelowDb(s, 30) } };
}
