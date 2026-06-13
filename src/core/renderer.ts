/**
 * Orchestrates rendering: resolves a soundref, checks the content-addressed
 * cache, runs the engine + analysis + lint on miss, and persists wav plus a
 * JSON sidecar so unchanged recipes are free to analyze.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Recipe } from "../schema.js";
import { AudioBuf } from "../dsp/buffer.js";
import { renderRecipe as engineRender, EngineContext, ENGINE_VERSION } from "../dsp/engine.js";
import { analyze, AnalysisBundle } from "../analysis/bundle.js";
import { lint, lintEnvelopeTruncation, LintFinding } from "../analysis/lint.js";
import { stft, Stft } from "../analysis/spectral.js";
import { decodeWav, encodeWav } from "../io/wav.js";
import { Workspace } from "./workspace.js";
import { RecipeStore } from "./store.js";
import { SoundRef } from "./soundref.js";
import { cacheKey, referencedFiles, hashBytes } from "./cache.js";

export interface RenderedSound {
  /** workspace-relative path of the audio (renders/... or refs/...) */
  file: string;
  bundle: AnalysisBundle;
  /** active findings, after the recipe's lint allow-list */
  findings: LintFinding[];
  /** findings suppressed by the recipe's lint.allow */
  suppressed: LintFinding[];
  mix: AudioBuf;
  recipe?: Recipe;
  version?: number;
  variant?: number;
  cached: boolean;
}

function splitFindings(findings: LintFinding[], allow: string[]): { active: LintFinding[]; suppressed: LintFinding[] } {
  if (allow.length === 0) return { active: findings, suppressed: [] };
  const allowed = new Set(allow);
  return {
    active: findings.filter((f) => !allowed.has(f.code)),
    suppressed: findings.filter((f) => allowed.has(f.code)),
  };
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export class Renderer {
  constructor(
    readonly ws: Workspace,
    readonly store: RecipeStore,
  ) {}

  private async engineCtx(): Promise<EngineContext> {
    const project = await this.ws.loadProject();
    return {
      project,
      loadRef: (file) => this.ws.loadRefAudio(file, project.sample_rate),
    };
  }

  /** Analyze a refs/ file as-is (no synthesis, no cache). */
  async renderRef(file: string): Promise<RenderedSound> {
    const project = await this.ws.loadProject();
    const mix = await this.ws.loadRefAudio(file, project.sample_rate);
    const { bundle, extras } = analyze(mix, { file });
    const findings = lint(mix, bundle, extras, { project });
    return { file, bundle, findings, suppressed: [], mix, cached: false };
  }

  async render(ref: SoundRef): Promise<RenderedSound> {
    if (ref.kind === "ref") return this.renderRef(ref.file);
    return this.renderRecipeVersion(ref.name, ref.version, ref.variant);
  }

  async renderRecipeVersion(name: string, version?: number, variant?: number): Promise<RenderedSound> {
    const { version: v, recipe } = await this.store.read(name, version);
    return this.renderRecipe(recipe, { variant, version: v });
  }

  /**
   * Render an already-validated recipe through the content-addressed cache
   * without consulting the store — the stateless path. The cache key is pure
   * content, so identical recipes hit the same entry whether they arrive
   * inline or from a stored version: previewing then committing costs one
   * render, and parallel callers never contend on version state.
   */
  async renderRecipe(recipe: Recipe, opts: { variant?: number; version?: number } = {}): Promise<RenderedSound> {
    const { variant, version: v } = opts;
    const project = await this.ws.loadProject();
    const name = recipe.name;

    if (variant !== undefined) {
      const count = recipe.variants?.count ?? 0;
      if (variant < 1 || variant > count) {
        throw new Error(
          count === 0
            ? `sound "${name}" has no variants; write a variants block or use make_variants`
            : `variant ${variant} out of range; "${name}" has variants 1..${count}`,
        );
      }
    }

    const refHashes: Record<string, string> = {};
    for (const file of referencedFiles(recipe, project)) {
      try {
        refHashes[file] = hashBytes(await this.ws.refBytes(file));
      } catch {
        throw new Error(`recipe "${name}" references missing file "${file}"; import it with import_reference`);
      }
    }

    const key = cacheKey({ recipe, variantIndex: variant, project, refHashes, engineVersion: ENGINE_VERSION });
    const baseName = variant !== undefined ? `${name}_${pad2(variant)}` : name;
    const relWav = `renders/${baseName}.${key.slice(0, 8)}.wav`;
    const relSidecar = `renders/${baseName}.${key.slice(0, 8)}.json`;
    const absWav = this.ws.resolve(relWav);
    const absSidecar = this.ws.resolve(relSidecar);

    try {
      const sidecar = JSON.parse(await fs.readFile(absSidecar, "utf8")) as {
        bundle: AnalysisBundle;
        findings: LintFinding[];
        suppressed?: LintFinding[];
      };
      const wavData = await fs.readFile(absWav);
      const mix = decodeWav(new Uint8Array(wavData));
      return {
        file: relWav,
        bundle: sidecar.bundle,
        findings: sidecar.findings,
        suppressed: sidecar.suppressed ?? [],
        mix,
        recipe,
        version: v,
        variant,
        cached: true,
      };
    } catch {
      // cache miss: render fresh
    }

    const ctx = await this.engineCtx();
    const result = await engineRender(recipe, ctx, variant);
    const { bundle, extras } = analyze(result.mix, { file: relWav, loopEnabled: recipe.loop.enabled, layers: result.layers });
    const allFindings = [
      ...lint(result.mix, bundle, extras, { recipe, project }),
      ...lintEnvelopeTruncation(result.layers, recipe.loop.enabled),
    ];
    const { active, suppressed } = splitFindings(allFindings, recipe.lint.allow);

    await fs.mkdir(path.dirname(absWav), { recursive: true });
    await fs.writeFile(absWav, encodeWav(result.mix, "float32"));
    await fs.writeFile(absSidecar, JSON.stringify({ bundle, findings: active, suppressed }, null, 2));

    return { file: relWav, bundle, findings: active, suppressed, mix: result.mix, recipe, version: v, variant, cached: false };
  }

  /** Whether both versions' base renders are already cached; used by diff for metric deltas. */
  async cachedBundle(name: string, version: number): Promise<AnalysisBundle | null> {
    try {
      const project = await this.ws.loadProject();
      const { recipe } = await this.store.read(name, version);
      const refHashes: Record<string, string> = {};
      for (const file of referencedFiles(recipe, project)) {
        refHashes[file] = hashBytes(await this.ws.refBytes(file));
      }
      const key = cacheKey({ recipe, project, refHashes, engineVersion: ENGINE_VERSION });
      const relSidecar = `renders/${name}.${key.slice(0, 8)}.json`;
      const sidecar = JSON.parse(await fs.readFile(this.ws.resolve(relSidecar), "utf8"));
      return sidecar.bundle as AnalysisBundle;
    } catch {
      return null;
    }
  }

  stftOf(sound: RenderedSound): Stft {
    return stft(sound.mix);
  }
}
