/**
 * Generates audition/index.html: play buttons for each sound and its
 * variants, refs/ files alongside for A/B listening, lint badges, version
 * labels. This page is where the human takes over.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { worstSeverity } from "../analysis/lint.js";
import { Renderer, RenderedSound } from "./renderer.js";
import { DECODABLE_EXTENSIONS } from "../io/audio.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function badge(severity: "error" | "warn" | "clean"): string {
  const colors = { error: "#e5484d", warn: "#f5a524", clean: "#46a758" };
  return `<span class="badge" style="background:${colors[severity]}">${severity}</span>`;
}

function player(relFromAudition: string, label: string): string {
  return `<div class="player"><span class="plabel">${esc(label)}</span><audio controls preload="none" src="${esc(relFromAudition)}"></audio></div>`;
}

export interface AuditionSound {
  name: string;
  version: number;
  base: RenderedSound;
  variants: RenderedSound[];
}

export async function generateAuditionPage(renderer: Renderer, sounds: AuditionSound[]): Promise<string> {
  const ws = renderer.ws;
  let refFiles: string[] = [];
  try {
    refFiles = (await fs.readdir(ws.refsDir))
      .filter((f) => DECODABLE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
      .sort();
  } catch {
    // no refs dir yet
  }

  const sections = sounds.map((s) => {
    const sev = worstSeverity([...s.base.findings, ...s.variants.flatMap((v) => v.findings)]);
    const findingsList = s.base.findings.length
      ? `<ul class="findings">${s.base.findings.map((f) => `<li><code>${f.code}</code> ${esc(f.message)}</li>`).join("")}</ul>`
      : "";
    const variantPlayers = s.variants
      .map((v) => player(`../${v.file}`, `#${v.variant}`))
      .join("\n");
    return `<section>
  <h2>${esc(s.name)} <span class="version">v${s.version}</span> ${badge(sev)}</h2>
  <div class="meta">${s.base.bundle.duration_ms} ms · peak ${s.base.bundle.peak_dbfs} dBFS · ${s.base.bundle.lufs_integrated} LUFS</div>
  ${player(`../${s.base.file}`, "base")}
  ${variantPlayers}
  ${findingsList}
</section>`;
  });

  const refsSection = refFiles.length
    ? `<section>
  <h2>References (A/B)</h2>
  ${refFiles.map((f) => player(`../refs/${f}`, f)).join("\n")}
</section>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mixdown audition</title>
<style>
  body { font-family: system-ui, sans-serif; background: #16161e; color: #e8e8ed; max-width: 880px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-bottom: .2rem; }
  section { border-bottom: 1px solid #333; padding: 1rem 0; }
  .version { color: #888; font-weight: normal; font-size: .85em; }
  .badge { font-size: .7em; padding: 2px 8px; border-radius: 8px; color: #fff; vertical-align: middle; }
  .meta { color: #999; font-size: .85em; margin-bottom: .5rem; }
  .player { display: flex; align-items: center; gap: .8rem; margin: .25rem 0; }
  .plabel { width: 6rem; color: #bbb; font-size: .9em; text-align: right; }
  audio { height: 32px; width: 100%; max-width: 560px; }
  .findings { color: #ccc; font-size: .85em; }
  code { color: #f5a524; }
</style>
</head>
<body>
<h1>mixdown audition</h1>
<p class="meta">generated ${new Date().toISOString()}</p>
${sections.join("\n")}
${refsSection}
</body>
</html>`;

  const outPath = path.join(ws.auditionDir, "index.html");
  await fs.writeFile(outPath, html);
  return "audition/index.html";
}
