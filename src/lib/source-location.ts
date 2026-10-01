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
