export const CAPTURE_STATES = [
  "pending",
  "attaching",
  "recording",
  "stop_requested",
  "flushing",
  "enriching",
  "captured",
  "captured_with_warnings",
  "failed",
  "interrupted",
] as const;

export type CaptureState = (typeof CAPTURE_STATES)[number];

export type CaptureStopReason =
  | "manual"
  | "buffer_limit"
  | "target_closed"
  | "detached"
  | "shutdown"
  | "error";

export interface CaptureTarget {
  tabId: number;
  title: string;
  url: string;
}

export interface CaptureRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  stoppedAt?: number;
  title: string;
  target: CaptureTarget;
  state: CaptureState;
  stopReason?: CaptureStopReason;
  bufferUsage: number;
  eventCount: number;
  chunkCount: number;
  byteCount: number;
  dataLoss: boolean;
  scriptsSeen: number;
  sourceMapsSeen: number;
  warnings: string[];
  error?: string;
  export?: {
    fileName: string;
    sizeBytes: number;
  };
}

export interface CaptureScriptMetadata {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  frameId?: string;
  sessionId?: string;
}

export interface CaptureSourceMap {
  url: string;
  sourceMapUrl: string;
  sourceMap: Record<string, unknown>;
}

export interface CaptureMainFrame {
  id: string;
  url: string;
  name: string;
}

export const ACTIVE_CAPTURE_STATES = new Set<CaptureState>([
  "pending",
  "attaching",
  "recording",
  "stop_requested",
  "flushing",
  "enriching",
]);

export function isCaptureState(value: unknown): value is CaptureState {
  return typeof value === "string" && (CAPTURE_STATES as readonly string[]).includes(value);
}
