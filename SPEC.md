# mixdown

MCP server spec, v0.1 draft.

## Purpose

Mixdown is a local MCP server that lets a language model design, edit, analyze, and batch-export game sound effects without being able to hear them. Sounds are deterministic synthesis recipes stored as JSON. The server renders recipes to audio, returns measurements and spectrogram images the model can read, lints for common defects, generates variant families, and emits an audition page so a human makes the final call by ear.

Quality bar: indie game SFX. Footsteps, impacts, UI clicks, ambience loops. Not music production.

## Architecture

One Node process speaking MCP over stdio. The server owns a single workspace directory and never touches files outside it, with one explicit exception noted under `import_reference`. There is no playback and no realtime path. Every operation is render-to-file plus analysis. Renders are cached by content hash, so analyzing an unchanged recipe is free.

Tool results follow MCP content conventions: a text block carrying a JSON payload, then zero or more PNG image blocks. A client that drops images still gets every number in the text block.

## Workspace layout

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

## project.json

```json
{
  "sample_rate": 44100,
  "channels_default": "mono",
  "loudness": { "mode": "peak", "peak_db": -1.0, "lufs_target": null },
  "naming": "{name}_{nn}",
  "seed": 7,
  "palette": {
    "resonators": {
      "wood_small": {
        "modes": [
          { "freq_hz": 410, "decay_ms": 90, "gain_db": 0 },
          { "freq_hz": 1130, "decay_ms": 40, "gain_db": -7 }
        ]
      }
    },
    "irs": { "cave_small": "refs/ir_cave_small.wav" }
  }
}
```

The palette is the consistency mechanism. Recipes reference resonators and impulse responses by name, so every wood impact in the project shares one physical character. Editing a palette entry invalidates the render cache for every recipe that uses it.

## Recipe format

```json
{
  "name": "stone_impact",
  "description": "rock dropped on rock, medium size",
  "duration_ms": 700,
  "channels": "mono",
  "seed": 41,
  "layers": [
    {
      "id": "crack",
      "source": { "type": "noise", "color": "white" },
      "filters": [
        { "type": "bandpass", "cutoff_hz": 3200, "q": 1.2 },
        { "type": "highpass", "cutoff_hz": 800, "q": 0.7 }
      ],
      "envelope": { "attack_ms": 1, "decay_ms": 60, "sustain": 0, "curve": "exp" },
      "gain_db": -6,
      "delay_ms": 0
    },
    {
      "id": "body",
      "source": { "type": "modal", "preset": "stone_large", "excite": "impulse" },
      "envelope": { "attack_ms": 2, "decay_ms": 350, "sustain": 0, "curve": "exp" },
      "gain_db": 0,
      "delay_ms": 4
    }
  ],
  "bus": [
    { "type": "reverb", "ir": "cave_small", "wet": 0.12 }
  ],
  "master": { "gain_db": 0 },
  "loop": { "enabled": false },
  "variants": {
    "count": 5,
    "jitter": { "pitch_semitones": 0.7, "gain_db": 1.0, "layer_delay_ms": 5, "cutoff_pct": 8 }
  }
}
```

### Sources

| type | fields | notes |
|---|---|---|
| noise | color: white, pink, brown, blue | seeded |
| osc | shape: sine, triangle, saw, square, pulse; freq_hz; duty; pitch_env { end_semitones, curve } | band-limited; pitch_env sweeps over the layer, the classic laser/jump shape |
| modal | preset (palette name) or inline modes []; excite: impulse, noise; excite_ms | impacts, rings, resonant bodies |
| sample | file (refs/ path); start_ms; end_ms | |
| granular | file; grain_ms; density_hz; position 0..1; position_jitter; pitch_jitter_semitones | textures: fire, water, crowd |

### Filters

Types: lowpass, highpass, bandpass, notch, peak, lowshelf, highshelf. Common fields: cutoff_hz (center frequency for band types), q, and gain_db on peak and shelf types only. An optional sweep `{ "end_hz": 200, "curve": "exp" }` interpolates the cutoff across the layer duration.

### Envelope

`{ attack_ms, hold_ms, decay_ms, sustain, release_ms, curve }` with curve one of lin, exp, log. Attack, hold, and decay run from layer start; sustain holds until duration_ms minus release_ms. All fields default to 0 except sustain, which defaults to 1.

### Bus effects

Applied in listed order to the layer sum. `reverb { ir, wet, predelay_ms }`, `delay { time_ms, feedback, wet }`, `eq { bands: [{ freq_hz, gain_db, q }] }`, `waveshaper { drive_db, shape: tanh | fold }`, `compressor { threshold_db, ratio, attack_ms, release_ms }`.

### Variants

The variants block stores a count and a jitter spec inside the recipe, so the base sound and its family have one source of truth. Each jitter field is the half-width of a uniform random offset: `pitch_semitones`, `gain_db`, `layer_delay_ms`, `cutoff_pct`. Variant n derives its randomness from hash(recipe.seed, n).

### Looping

`loop: { enabled, crossfade_ms }`. When enabled, render performs an equal-power crossfade of the tail into the head, trims to the loop length, and measures the seam.

### Semantics

Signal flow per layer: source, then pitch shift, then filters in listed order, then envelope, then gain_db, then the layer is offset by delay_ms and summed. The sum passes through bus effects in order, then master gain.

Units everywhere: milliseconds, Hz, dB, semitones, wet mix 0..1, q unitless.

Determinism: a recipe plus an engine_version renders to byte-identical output. Layer randomness derives from hash(recipe.seed, layer.id), so editing one layer never reshuffles another.

## Tools

Sixteen tools. Several accept a sound reference:

```
soundref := name [ "@" version ] [ "#" variant ]
          | "refs/" filename
```

### list_sounds

Lists every recipe with current version, duration, variant count, and worst lint severity.

### read_recipe

```json
in:  { "name": "stone_impact", "version": 3 }
out: { "version": 3, "recipe": { ... } }
```

Version omitted means head.

### write_recipe

Create or replace a recipe. Validates against the schema, fills defaults, bumps the version, snapshots the previous version to history. Writing a new name creates the sound; there is no separate create tool.

```json
in:  { "name": "stone_impact", "recipe": { ... } }
out: { "version": 4, "warnings": [] }
```

### patch_recipe

RFC 7386 JSON merge patch against the head version, for small edits without resending the document.

```json
in:  { "name": "stone_impact", "patch": { "layers": null } }
```

Arrays replace whole; to edit one layer, patch with the full layers array or use write_recipe.

### list_presets

Returns every enum the server accepts: source types and their fields, filter types, effect types, curve names, palette resonators, palette IRs, jitter fields. The server is self-describing. A model should call this once per session instead of guessing field names.

### render

```json
in:  { "ref": "stone_impact#2", "images": "spectrogram" }
```

`images` is one of none, spectrogram, spectrogram+waveform. Output is the analysis bundle (below), lint findings, the cached wav path, and the requested image blocks. A `refs/` soundref skips synthesis and analyzes the file as-is, which is how reference audio gets the same treatment as recipes.

### compare

```json
in:  { "a": "stone_impact@3", "b": "refs/target_stone.wav" }
```

Returns metric deltas, a per-band energy delta table, and one image: both spectrograms stacked on identical axes.

### lint

Findings only, no images. Uses the render cache, so it is cheap when nothing changed.

### make_variants

```json
in:  { "name": "stone_impact", "count": 6, "jitter": { "pitch_semitones": 0.6 } }
```

Writes the variants block, renders all variants, and returns a per-variant table of peak, centroid, and duration alongside a single strip image of all variant spectrograms.

### import_reference

Copies an audio file from an absolute local path into refs/ and returns its analysis bundle. The only tool that reads outside the workspace.

### audition_page

Regenerates audition/index.html covering the given names, or everything when omitted: play buttons for each sound and variant, any refs/ files placed alongside the sounds that compare against them for A/B listening, lint badges, version labels. Returns the path. This page is where the human takes over.

### export

```json
in:  { "names": ["stone_impact"], "include_variants": true, "format": "ogg" }
out: { "manifest": [ { "file": "exports/stone_impact_01.ogg", "lufs": -17.2, "peak_db": -1.0 } ] }
```

Applies project loudness and naming. Defaults: mono, 44.1 kHz, ogg vorbis. Refuses if any error-severity lint finding exists, unless `force: true`.

### history, checkpoint, revert, diff

`history(name)` lists versions with timestamps and labels. `checkpoint(name, label)` labels the head. `revert(name, version)` writes an old recipe as the new head. `diff(name, from, to)` returns a recipe field diff, plus metric deltas when both versions are already in the render cache.

## Analysis bundle

Returned by render, compare (per side), and import_reference.

```json
{
  "engine_version": "0.1.0",
  "file": "renders/stone_impact.9f3a.wav",
  "duration_ms": 700,
  "channels": 1,
  "peak_dbfs": -1.4,
  "true_peak_dbtp": -1.1,
  "rms_dbfs": -16.2,
  "lufs_integrated": -17.8,
  "dc_offset_db": -72,
  "attack_ms": 3,
  "decay_to_minus40_ms": 410,
  "tail_silence_ms": 90,
  "spectral_centroid_hz": { "mean": 1850, "at_10ms": 3400, "at_100ms": 1200, "at_end": 600 },
  "band_energy_db": {
    "20-60": -38, "60-150": -21, "150-400": -14, "400-1k": -12,
    "1k-2.5k": -15, "2.5k-6k": -19, "6k-12k": -27, "12k-20k": -41
  },
  "resonances": [ { "freq_hz": 312, "prominence_db": 14 } ],
  "layers": [ { "id": "crack", "peak_dbfs": -9.1, "masked_above_ms": 85 } ],
  "loop_seam_db": null
}
```

`masked_above_ms` is the time after which the layer never rises within 25 dB of the mix; null means audible throughout. `loop_seam_db` measures the worst inter-sample step at the loop seam; null when looping is off. The centroid trajectory exists because "starts bright, ends dull" is most of what timbre words mean, and three sample points carry it.

## Spectrogram conventions

Fixed across every render so images stay comparable between turns: log frequency axis from 20 Hz to 20 kHz, dB scale pinned at 0 to -80 dBFS, one colormap, time axis in ms, 880 x 440 px PNG. Brightness is never auto-scaled. A quieter render must look dimmer, or the model loses its only visual loudness cue.

## Lint rules

| code | severity | check |
|---|---|---|
| E101 | error | true peak above -0.3 dBTP |
| E102 | error | DC offset above -60 dBFS |
| E103 | error | click: inter-sample step over threshold at start, end, or interior |
| E104 | error | loop enabled and seam discontinuity over threshold |
| W201 | warn | energy below 30 Hz above -40 dBFS |
| W202 | warn | silent tail longer than 250 ms |
| W203 | warn | a layer is masked for its entire duration |
| W204 | warn | stereo recipe exported to a mono target |
| W205 | warn | loudness more than 6 dB from project target |
| W206 | warn | envelope truncated: layer tail cut more than 20 dB above the floor at duration_ms |

Render and export both attach findings, so the model sees defects without a separate call.

## Error model

Validation failures name the JSON pointer, the constraint, and the offending value:

```json
{ "error": "validation", "path": "/layers/0/filters/1/cutoff_hz", "message": "must be 20..20000", "got": 24000 }
```

Unknown enum values return the allowed list. Errors are written for a model to repair the recipe in one step, which matters more here than in a human-facing API.

## Implementation notes

Node 20+, TypeScript, the official @modelcontextprotocol/sdk over stdio, tool inputs declared as zod schemas. The DSP is hand-rolled on Float32Array, all of it textbook: RBJ cookbook biquads for every filter type, polyBLEP oscillators, modal resonators as banks of two-pole filters, envelopes as plain loops, windowed-sinc resampling for pitch shift, and fft.js for the STFT and overlap-add convolution reverb. LUFS is BS.1770 implemented directly, K-weighting biquads plus gating, around eighty lines. Seeded randomness is mulberry32, since JS ships no seeded PRNG.

File IO: wav read and write in pure JS; ogg vorbis encodes through wasm-media-encoders and decodes through @wasm-audio-decoders, so refs and exports work without ffmpeg. Spectrograms render through @napi-rs/canvas, which ships prebuilt binaries and provides real text for axis labels. Net result: no native compile step anywhere, and the server installs as a single npx line in the client config, which is how MCP servers actually get distributed.

Internal processing in float32 at project sample rate. Performance target: under 500 ms to render a 2 second mono sound on a laptop. Two seconds of mono is 88,200 samples; V8 handles these loops without WASM.

Cache key: sha256 over canonical recipe JSON, variant index, the resolved palette entries it references, and engine_version. JS math functions are implementation-approximated, so byte-identical determinism holds per runtime rather than universally: engine_version embeds the Node major, e.g. `0.1.0-node20`, and bumping either part invalidates the cache, which is the honest behavior when DSP changes.

## Out of scope for v1

Music, sequencing, MIDI, realtime preview, plugin hosting, and text-to-audio generation. The source type name `genai` is reserved so a generated layer can slot into recipes later without a schema break.

## v0.2 additions

Engine 0.2.0, shaped by the first real design sessions. All recipe additions are optional and backward compatible; the engine version bump invalidates the render cache, which is the honest behavior since the DC fixes change output.

**Correctness.** Modal sources run a 15 Hz DC blocker (impulse-excited resonators integrate to nonzero area and tripped E102 on every modal recipe). Pulse oscillators subtract their duty-cycle offset (`2*duty - 1`).

**LFO.** Per-layer sine LFO: `lfo: { target: gain | pitch | cutoff, rate_hz, rate_end_hz?, depth, curve }`. `rate_end_hz` sweeps the rate across the layer for accelerating wobbles. Depth units follow the target: dB, semitones (osc sources only), or percent of cutoff (requires a filter). Phase starts at zero; fully deterministic.

**Pitch envelope breakpoints.** `pitch_env` accepts either the original `{ end_semitones, curve }` sweep or `{ points: [{ at: 0..1, semitones }], curve }` for rise-then-fall contours in one layer.

**Per-segment envelope curves.** `attack_curve`, `decay_curve`, `release_curve` override the shared `curve`, so a slow log swell can end in a click-free lin release.

**Effect tails ring out.** Delay and reverb keep sounding past `duration_ms`; the buffer extends by the effects' decay time and trailing samples below -66 dBFS are trimmed. `duration_ms` in the analysis bundle reports the actual rendered length. Loops are never extended.

**Master fades.** `master: { fade_in_ms, fade_out_ms, fade_curve }` for global fades; rejected on loops since they would break the seam.

**Lint intent.** `lint: { allow: ["W206", ...] }` suppresses findings a recipe triggers deliberately (e.g. a riser that ends at peak). Suppressed findings are reported separately and do not block export.

**Tools.** `patch_layer(name, layer_id, patch)` applies a merge patch to one layer by id (null removes it) — single-field edits no longer resend the layers array. `freeze(ref, name?)` bounces a rendered sound into `refs/` for use as a sample, granular, or IR source. `make_variants` no longer bumps the version when the variants block is unchanged. `hidden: true` keeps working-material recipes off the audition page. Eighteen tools total.

## Stateless mode

Built for multi-agent sessions: when several subagents explore candidates for the same sound, the write-then-render loop makes them race on the head version and pollute history. Stateless tools carry the recipe inline instead, so the only shared state is the content-addressed render cache, which is conflict-free by construction (identical content maps to identical files).

**preview(recipe, variant?, images?, strict?)** renders a full inline recipe document and returns the same analysis bundle, lint findings, and images as `render` — without touching `sounds/` or `history/`, and with no version bump. The cache key is pure content, so previewing a document and later committing it with `write_recipe` costs one render. The recipe's `name` only labels the cached wav and defaults to `preview`.

**compare** accepts an inline recipe document for either side, rendered the same stateless way, so a candidate can be measured against the stored head or a reference before anything is written.

The intended flow: subagents iterate with `preview` (and `compare` against the head or a ref), keeping their candidate in their own context; the orchestrator commits the winner once with `write_recipe`. Nineteen tools total.
