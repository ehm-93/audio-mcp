/**
 * The workspace directory the server owns. All file access goes through
 * resolve(), which refuses paths that escape the root; import_reference is
 * the one caller that reads outside, and it does so explicitly.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Project, projectSchema, validateOrThrow } from "../schema.js";
import { AudioBuf } from "../dsp/buffer.js";
import { decodeAudio, resampleTo } from "../io/audio.js";

export class Workspace {
  readonly soundsDir: string;
  readonly refsDir: string;
  readonly rendersDir: string;
  readonly exportsDir: string;
  readonly auditionDir: string;
  readonly historyDir: string;
  private projectCache: { mtimeMs: number; project: Project } | null = null;
  private refCache = new Map<string, { mtimeMs: number; rate: number; buf: AudioBuf }>();

  constructor(readonly root: string) {
    this.soundsDir = path.join(root, "sounds");
    this.refsDir = path.join(root, "refs");
    this.rendersDir = path.join(root, "renders");
    this.exportsDir = path.join(root, "exports");
    this.auditionDir = path.join(root, "audition");
    this.historyDir = path.join(root, "history");
  }

  async init(): Promise<void> {
    for (const dir of [this.root, this.soundsDir, this.refsDir, this.rendersDir, this.exportsDir, this.auditionDir, this.historyDir]) {
      await fs.mkdir(dir, { recursive: true });
    }
    const projectPath = path.join(this.root, "project.json");
    try {
      await fs.access(projectPath);
    } catch {
      const defaults = projectSchema.parse({});
      await fs.writeFile(projectPath, JSON.stringify(defaults, null, 2));
    }
  }

  /** Resolve a workspace-relative path, refusing escapes. */
  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`path "${rel}" escapes the workspace`);
    }
    return abs;
  }

  async loadProject(): Promise<Project> {
    const projectPath = path.join(this.root, "project.json");
    const stat = await fs.stat(projectPath);
    if (this.projectCache && this.projectCache.mtimeMs === stat.mtimeMs) return this.projectCache.project;
    const raw = JSON.parse(await fs.readFile(projectPath, "utf8"));
    const project = validateOrThrow(projectSchema, raw);
    this.projectCache = { mtimeMs: stat.mtimeMs, project };
    return project;
  }

  /** Load a refs/ audio file resampled to targetRate, memoized by mtime. */
  async loadRefAudio(relPath: string, targetRate: number): Promise<AudioBuf> {
    if (!relPath.startsWith("refs/")) throw new Error(`"${relPath}" is not a refs/ path`);
    const abs = this.resolve(relPath);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`reference file "${relPath}" not found; import it first with import_reference`);
    }
    const cached = this.refCache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.rate === targetRate) return cached.buf;
    const data = await fs.readFile(abs);
    const decoded = await decodeAudio(new Uint8Array(data), path.extname(abs));
    const buf = resampleTo(decoded, targetRate);
    this.refCache.set(abs, { mtimeMs: stat.mtimeMs, rate: targetRate, buf });
    return buf;
  }

  /** Content bytes of a refs file, for cache keys. */
  async refBytes(relPath: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(this.resolve(relPath)));
  }
}
