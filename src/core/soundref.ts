/**
 * soundref := name [ "@" version ] [ "#" variant ] | "refs/" filename
 */

export type SoundRef =
  | { kind: "recipe"; name: string; version?: number; variant?: number }
  | { kind: "ref"; file: string };

export function parseSoundRef(ref: string): SoundRef {
  if (ref.startsWith("refs/")) {
    if (/[\\]|\.\./.test(ref)) throw new Error(`invalid refs path "${ref}"`);
    return { kind: "ref", file: ref };
  }
  const m = /^([a-zA-Z0-9_-]+)(@(\d+))?(#(\d+))?$/.exec(ref);
  if (!m) {
    throw new Error(`invalid soundref "${ref}"; expected name[@version][#variant] or refs/filename`);
  }
  return {
    kind: "recipe",
    name: m[1],
    version: m[3] !== undefined ? Number(m[3]) : undefined,
    variant: m[5] !== undefined ? Number(m[5]) : undefined,
  };
}

export function formatSoundRef(ref: SoundRef): string {
  if (ref.kind === "ref") return ref.file;
  return ref.name + (ref.version !== undefined ? `@${ref.version}` : "") + (ref.variant !== undefined ? `#${ref.variant}` : "");
}
