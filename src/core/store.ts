/**
 * Recipe storage with versioning. The head lives at sounds/{name}.json;
 * every version (including the head) is snapshotted to history/{name}/v{n}.json
 * with timestamps and labels in history/{name}/meta.json.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Recipe, recipeSchema, validateOrThrow } from "../schema.js";
import { Workspace } from "./workspace.js";

interface HistoryMeta {
  head: number;
  timestamps: Record<string, string>;
  labels: Record<string, string>;
}

export interface VersionInfo {
  version: number;
  timestamp: string;
  label: string | null;
  is_head: boolean;
}

export class RecipeStore {
  constructor(private ws: Workspace) {}

  private headPath(name: string): string {
    return path.join(this.ws.soundsDir, `${name}.json`);
  }

  private metaPath(name: string): string {
    return path.join(this.ws.historyDir, name, "meta.json");
  }

  private versionPath(name: string, version: number): string {
    return path.join(this.ws.historyDir, name, `v${version}.json`);
  }

  private async loadMeta(name: string): Promise<HistoryMeta | null> {
    try {
      return JSON.parse(await fs.readFile(this.metaPath(name), "utf8"));
    } catch {
      return null;
    }
  }

  private async saveMeta(name: string, meta: HistoryMeta): Promise<void> {
    await fs.mkdir(path.dirname(this.metaPath(name)), { recursive: true });
    await fs.writeFile(this.metaPath(name), JSON.stringify(meta, null, 2));
  }

  async listNames(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.ws.soundsDir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await fs.access(this.headPath(name));
      return true;
    } catch {
      return false;
    }
  }

  async headVersion(name: string): Promise<number> {
    const meta = await this.loadMeta(name);
    if (!meta) throw new Error(`unknown sound "${name}"`);
    return meta.head;
  }

  /** Read a recipe; version omitted means head. */
  async read(name: string, version?: number): Promise<{ version: number; recipe: Recipe }> {
    const meta = await this.loadMeta(name);
    if (!meta) {
      const names = await this.listNames();
      throw new Error(`unknown sound "${name}"; workspace has: ${names.join(", ") || "(none)"}`);
    }
    const v = version ?? meta.head;
    let raw: string;
    try {
      raw = await fs.readFile(this.versionPath(name, v), "utf8");
    } catch {
      throw new Error(`sound "${name}" has no version ${v}; head is ${meta.head}`);
    }
    return { version: v, recipe: validateOrThrow(recipeSchema, JSON.parse(raw)) };
  }

  /**
   * Create or replace a recipe: validate, fill defaults, bump the version,
   * snapshot. Returns the new version number.
   */
  async write(name: string, recipeInput: unknown): Promise<{ version: number; recipe: Recipe }> {
    const recipe = validateOrThrow(recipeSchema, { ...(recipeInput as object), name });
    const meta = (await this.loadMeta(name)) ?? { head: 0, timestamps: {}, labels: {} };
    const version = meta.head + 1;
    meta.head = version;
    meta.timestamps[String(version)] = new Date().toISOString();

    const json = JSON.stringify(recipe, null, 2);
    await fs.mkdir(path.dirname(this.versionPath(name, version)), { recursive: true });
    await fs.writeFile(this.versionPath(name, version), json);
    await fs.writeFile(this.headPath(name), json);
    await this.saveMeta(name, meta);
    return { version, recipe };
  }

  async history(name: string): Promise<VersionInfo[]> {
    const meta = await this.loadMeta(name);
    if (!meta) throw new Error(`unknown sound "${name}"`);
    const versions: VersionInfo[] = [];
    for (let v = 1; v <= meta.head; v++) {
      const ts = meta.timestamps[String(v)];
      if (!ts) continue; // version file may have been pruned
      versions.push({ version: v, timestamp: ts, label: meta.labels[String(v)] ?? null, is_head: v === meta.head });
    }
    return versions;
  }

  async checkpoint(name: string, label: string): Promise<number> {
    const meta = await this.loadMeta(name);
    if (!meta) throw new Error(`unknown sound "${name}"`);
    meta.labels[String(meta.head)] = label;
    await this.saveMeta(name, meta);
    return meta.head;
  }

  /** Write an old version as the new head. */
  async revert(name: string, version: number): Promise<{ version: number; recipe: Recipe }> {
    const old = await this.read(name, version);
    return this.write(name, old.recipe);
  }
}

/** RFC 7386 JSON merge patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }
  const result: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

/**
 * Layer-addressed merge patch: applies an RFC 7386 patch to the layer with
 * the given id, without resending the rest of the document. A null patch
 * removes the layer.
 */
export function applyLayerPatch(recipe: Recipe, layerId: string, patch: unknown): unknown {
  const idx = recipe.layers.findIndex((l) => l.id === layerId);
  if (idx < 0) {
    throw new Error(`no layer "${layerId}" in "${recipe.name}"; layers: ${recipe.layers.map((l) => l.id).join(", ")}`);
  }
  const layers: unknown[] = [...recipe.layers];
  if (patch === null) layers.splice(idx, 1);
  else layers[idx] = mergePatch(recipe.layers[idx], patch);
  return { ...recipe, layers };
}

/** Recursive field diff between two JSON documents, as JSON-pointer rows. */
export function recipeDiff(from: unknown, to: unknown, basePath = ""): { path: string; from: unknown; to: unknown }[] {
  if (JSON.stringify(from) === JSON.stringify(to)) return [];
  const bothObjects =
    from !== null && to !== null && typeof from === "object" && typeof to === "object" &&
    Array.isArray(from) === Array.isArray(to);
  if (!bothObjects) {
    return [{ path: basePath || "/", from, to }];
  }
  const keys = new Set([...Object.keys(from as object), ...Object.keys(to as object)]);
  const rows: { path: string; from: unknown; to: unknown }[] = [];
  for (const key of [...keys].sort()) {
    const f = (from as Record<string, unknown>)[key];
    const t = (to as Record<string, unknown>)[key];
    if (f === undefined && t !== undefined) rows.push({ path: `${basePath}/${key}`, from: undefined, to: t });
    else if (f !== undefined && t === undefined) rows.push({ path: `${basePath}/${key}`, from: f, to: undefined });
    else rows.push(...recipeDiff(f, t, `${basePath}/${key}`));
  }
  return rows;
}
