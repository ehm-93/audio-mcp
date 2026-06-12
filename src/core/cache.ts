/**
 * Render cache keyed by sha256 over canonical recipe JSON, variant index,
 * the resolved palette entries (and content hashes of any referenced refs
 * files), and engine_version.
 */

import { createHash } from "node:crypto";
import { Recipe, Project } from "../schema.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as object).sort();
  return (
    "{" +
    keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/** The refs/ files a recipe depends on: sample and granular sources plus reverb IRs. */
export function referencedFiles(recipe: Recipe, project: Project): string[] {
  const files = new Set<string>();
  for (const layer of recipe.layers) {
    if (layer.source.type === "sample" || layer.source.type === "granular") files.add(layer.source.file);
  }
  for (const fx of recipe.bus) {
    if (fx.type === "reverb") {
      const resolved = project.palette.irs[fx.ir] ?? fx.ir;
      if (resolved.startsWith("refs/")) files.add(resolved);
    }
  }
  return [...files].sort();
}

/** Palette entries the recipe references, so editing one invalidates dependent renders. */
export function resolvedPaletteSlice(recipe: Recipe, project: Project): Record<string, unknown> {
  const slice: Record<string, unknown> = {};
  for (const layer of recipe.layers) {
    if (layer.source.type === "modal" && layer.source.preset) {
      slice[`resonator:${layer.source.preset}`] = project.palette.resonators[layer.source.preset] ?? null;
    }
  }
  for (const fx of recipe.bus) {
    if (fx.type === "reverb") {
      slice[`ir:${fx.ir}`] = project.palette.irs[fx.ir] ?? null;
    }
  }
  return slice;
}

export interface CacheKeyInputs {
  recipe: Recipe;
  variantIndex?: number;
  project: Project;
  /** content hashes of referenced refs files, keyed by refs/ path */
  refHashes: Record<string, string>;
  engineVersion: string;
}

export function cacheKey(inputs: CacheKeyInputs): string {
  const material = canonicalJson({
    recipe: inputs.recipe,
    variant: inputs.variantIndex ?? null,
    palette: resolvedPaletteSlice(inputs.recipe, inputs.project),
    sample_rate: inputs.project.sample_rate,
    channels_default: inputs.project.channels_default,
    refs: inputs.refHashes,
    engine: inputs.engineVersion,
  });
  return createHash("sha256").update(material).digest("hex");
}

export function hashBytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
