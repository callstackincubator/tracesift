export interface TraceExportMainFrame {
  id: string;
  url: string;
  name: string;
}

export interface TraceMarkerLocation {
  pid: number;
  tid: number;
  ts: number;
}

export interface TraceExportOptions {
  /** Path to the raw trace Chrome streamed over IO.read. */
  spool: string;
  /** Final `.json.gz` path; written atomically through a sibling temporary. */
  destination: string;
  /** Enhanced-trace `metadata` object, serialized verbatim. */
  metadata: Record<string, unknown>;
  mainFrame?: TraceExportMainFrame;
  /** Used when the main frame reported no URL of its own. */
  fallbackUrl?: string;
  /** Renderer-main marker name recorded at `Tracing.start`. */
  traceMarker?: string;
}

export function copyTraceEvents(spool: string, output: NodeJS.WritableStream): Promise<number>;

export function inspectTraceMetadata(spool: string, traceMarker: string): Promise<{
  hasInspectorMetadata: boolean;
  marker?: TraceMarkerLocation;
}>;

export function writeTraceExport(options: TraceExportOptions): Promise<{
  sizeBytes: number;
  eventCount: number;
}>;
