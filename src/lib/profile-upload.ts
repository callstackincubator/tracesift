import { gunzip } from "node:zlib";
import { promisify } from "node:util";

import { maxUploadBytes } from "./analysis.ts";

const inflate = promisify(gunzip);

/** The two bytes every gzip member starts with. */
const GZIP_MAGIC = [0x1f, 0x8b];

export class ProfileUploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProfileUploadError";
    this.status = status;
  }
}

/** Does this upload begin with a gzip member? Sniffed, not trusted to the name. */
async function isGzip(profile: File): Promise<boolean> {
  if (profile.size < GZIP_MAGIC.length) return false;
  const head = new Uint8Array(await profile.slice(0, GZIP_MAGIC.length).arrayBuffer());
  return GZIP_MAGIC.every((byte, index) => head[index] === byte);
}

/**
 * The profile as the analyzers want it: plain JSON bytes.
 *
 * A trace exported by the web app or by `tracesift record` is gzipped — the
 * uncompressed document runs to tens of megabytes — and every reader below
 * this point parses the upload as text. Rather than teach each of them about
 * compression, inflate once here and hand on an ordinary `File`, so an
 * exported `.json.gz` can be uploaded or sent to the Integration API exactly
 * as a `.json` is.
 *
 * Content, not the extension, decides: a trace saved without its suffix still
 * opens, and a `.json` that happens to be named `.gz` is left alone.
 */
export async function decompressedProfile(profile: File): Promise<File> {
  if (!(await isGzip(profile))) return profile;

  // The size check the caller already made was against the compressed bytes.
  // Parsing needs the whole document as one V8 string, so the inflated size is
  // what actually has to fit, and zlib stops rather than filling memory first.
  const limit = maxUploadBytes();
  let inflated: Buffer;
  try {
    inflated = await inflate(Buffer.from(await profile.arrayBuffer()), { maxOutputLength: limit });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new ProfileUploadError(413, `The profile is too large once uncompressed (max ${Math.floor(limit / (1024 * 1024))} MB).`);
    }
    throw new ProfileUploadError(400, "The uploaded file looks gzipped but could not be decompressed.");
  }

  const name = profile.name.replace(/\.gz$/i, "");
  return new File([new Uint8Array(inflated)], name || profile.name, { type: "application/json" });
}
