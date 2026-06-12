# mixdown

A local MCP server that lets a language model design, edit, analyze, and batch-export game sound effects without being able to hear them. Sounds are deterministic synthesis recipes stored as JSON; the server renders them to audio, returns measurements and spectrogram images the model can read, lints for common defects, generates variant families, and emits an audition page so a human makes the final call by ear.

See [SPEC.md](SPEC.md) for the full design.

## Setup

Requires Node 20+. No native compile step — wav/ogg/flac IO is pure JS + wasm, spectrograms use prebuilt binaries.

```bash
npm install
npm run build
```

Add to your MCP client config (e.g. Claude Desktop or `.mcp.json`):

```json
{
  "mcpServers": {
    "mixdown": {
      "command": "node",
      "args": ["/path/to/audio-mcp/dist/index.js", "/path/to/your/sfx-workspace"]
    }
  }
}
```

The workspace argument defaults to `$MIXDOWN_WORKSPACE`, then the current directory. The server creates the layout on first run:

```
workspace/
  project.json          shared settings and palette
  sounds/               one JSON recipe per sound
  refs/                 imported reference audio (wav, ogg, flac)
  renders/              cache, content-addressed, safe to delete
  exports/              game-ready files
  audition/index.html   generated listening page
  history/              recipe version snapshots
```

## Tools

| tool | purpose |
|---|---|
| `list_sounds` | every recipe with version, duration, variant count, worst lint severity |
| `read_recipe` / `write_recipe` / `patch_recipe` | CRUD with versioning; patch is RFC 7386 merge patch |
| `patch_layer` | merge patch one layer by id without resending the layers array |
| `list_presets` | every enum the server accepts — call once per session |
| `render` | render (cached by content hash) → analysis bundle, lint findings, spectrogram/waveform PNGs |
| `compare` | metric deltas, per-band energy deltas, stacked spectrograms on identical axes |
| `lint` | findings only, served from the render cache |
| `make_variants` | write the variants block, render the family, return a table + strip image |
| `import_reference` | copy outside audio into `refs/` and analyze it |
| `freeze` | bounce a rendered sound into `refs/` for reuse as a sample/granular/IR source |
| `audition_page` | regenerate the human listening page |
| `export` | loudness-normalized ogg/wav with naming template; refuses on lint errors unless forced |
| `history` / `checkpoint` / `revert` / `diff` | version management |

v0.2 recipe features: per-layer LFO (gain/pitch/cutoff with sweepable rate), breakpoint pitch envelopes, per-segment envelope curves, master fades, automatic delay/reverb tail ring-out, per-recipe lint allow-list, `hidden` flag. See the v0.2 section in [SPEC.md](SPEC.md).

## Development

```bash
npm test                          # vitest: DSP, store, end-to-end
node --import tsx scripts/smoke.ts   # protocol-level smoke test over stdio (build first)
node --import tsx scripts/preview.ts # render sample PNGs to tmp-preview/
```

Determinism: a recipe plus an engine version renders byte-identical output on the same Node major; the engine version embeds the Node major (e.g. `0.1.0-node26`) and is part of the render cache key.
