/**
 * One rule for deciding whether a recorded frame location names a source file a
 * developer can open. Bundle URLs, native frames, and virtual schemes are not
 * source paths: they must never be presented as one, in prompts or in the UI.
 */

/** `location` may be a bare path or a full `path:line:column` label. */
export function isReadableSourcePath(location: string): boolean {
  // V8 and Hermes label built-ins `native array.js`, `native date.js` and the
  // like. Those end in `.js` and carry no scheme, so the tests below would
  // otherwise accept them as a file a developer could open.
  if (/^native\s/i.test(location)) return false;
  const readable = !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(location) || /^[a-z]:[\\/]/i.test(location);
  return readable && /\.(?:[cm]?[jt]sx?|vue|svelte)(?::|$)/i.test(location);
}

/** The frame's own source position, or undefined when it has no readable path. */
export function frameSourceLocation(frame: { url: string; lineNumber: number; columnNumber: number }): string | undefined {
  if (!frame.url || !isReadableSourcePath(frame.url)) return undefined;
  if (frame.lineNumber < 0) return frame.url;
  return `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
}

/**
 * Build artefacts in a frame label: enough to tell one chunk from another, and
 * nothing else.
 *
 * A minified frame's position is still worth printing — it is what separates
 * two `(anonymous)` frames, and the chunk name says whether the cost sits in
 * the app or in a dependency. The origin and the content hash say neither: the
 * origin repeats on every line of every stack, and the hash changes with each
 * build. Both are dropped so a stack reads as frames rather than as URLs.
 */
function stripContentHash(fileName: string): string {
  // Only a hash that follows a stem is removed; a bare `base64url.js` is the
  // stem itself and keeps its name.
  return fileName.replace(/(?<=[^-.])[-.]([0-9a-f]{8,}|(?=[\w-]*\d)(?=[\w-]*[a-zA-Z])[\w-]{8,})(?=\.)/g, "");
}

/** The shortest label that still identifies a frame's position. */
export function compactLocation(url: string, lineNumber: number, columnNumber: number): string {
  const position = lineNumber < 0 ? "" : `:${lineNumber + 1}:${columnNumber + 1}`;
  if (isReadableSourcePath(url)) return `${url}${position}`;
  const fileName = url.split(/[?#]/, 1)[0].split("/").pop() || url;
  return `${stripContentHash(fileName)}${position}`;
}

/**
 * Whether a label `compactLocation` produced names a source file rather than a
 * build artefact.
 *
 * `isReadableSourcePath` cannot answer this, because it is given the whole URL
 * and this is given what compaction left of it. Its scheme test needs a letter
 * first, so `main.bundle.js:91:1` is rejected only by accidentally looking like
 * a scheme, and `8339.bundle.js:1:92293` — a numbered chunk, which is what code
 * splitting actually emits — is accepted as a path a developer could open. Two
 * callers trusted it with a compacted label and so believed a chunk was a file.
 *
 * Compaction keeps a readable URL whole, with its directories, and cuts
 * everything else back to a bare file name, so a label carrying a separator is
 * the readable branch. A bare name is judged on its extension instead: no
 * bundler emits `.tsx`, `.ts`, `.vue` or `.svelte`, while a chunk is always
 * plain JavaScript. That second branch is for a label carrying no position, as
 * `prompt-data.ts` parses out, because a bare `Search.tsx:12:1` reads as a URL
 * scheme to the whole-URL test and never reaches here.
 *
 * The one case this gets wrong is a source file reached by a bare relative
 * `format.js`, read as an artefact — and the whole cost of that is a hidden
 * position beside a name that already located the frame.
 */
export function isSourceLabel(location: string): boolean {
  if (!isReadableSourcePath(location)) return false;
  return /[\\/]/.test(location) || !/\.[cm]?js(?::|$)/i.test(location);
}
