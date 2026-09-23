"use client";

import Image from "next/image";
import { ChangeEvent, DragEvent, useEffect, useId, useRef, useState } from "react";
import {
  Alert,
  ArrowRight,
  Button,
  Check,
  Copy,
  PluginHeader,
  PluginShell,
  RozeniteLoader,
  Text,
} from "@rozenite/ui";

import { HowToUseGuide } from "@/app/how-to-use";
import type { Hotspot } from "@/lib/analysis";
import type { ReactIssue } from "@/lib/react-analyzer";

type ProfileType = "javascript" | "react";
type UploadKind = "cpu" | "reactProfile";
type Phase = "upload" | "analyzing" | "results";

interface AnalyzeResponse {
  analysisId: string;
  profileType?: "cpu" | "react";
  title?: string;
  saved?: boolean;
  totalMs: number;
  hotspots: Hotspot[];
  usage?: TokenUsage;
}
interface HistoryItem { id: string; createdAt: number; profileType: "cpu" | "react"; title: string; totalTokens: number; issueCount: number; }
interface SavedAnalysis { id: string; createdAt: number; profileType: "cpu" | "react"; title: string; saved: boolean; totalMs: number; hotspots: Hotspot[]; reactIssues: ReactIssue[]; prompts: Record<string, string>; promptUsage: Record<string, TokenUsage>; usage: TokenUsage; }
interface ModelProvider { id: string; name: string; keyConfigured: boolean; models: Array<{ id: string; name: string }>; }
interface ModelSettings {
  configured: boolean;
  providerId?: string;
  modelId?: string;
  provider?: string;
  model?: string;
  error?: string;
  providers: ModelProvider[];
}

interface ReactSummary {
  peakCommitDurationMs: number | null;
  commitsOverBudget: number;
  omittedEvidenceCommitCount: number;
  rootCount: number;
  commitCount: number;
  totalCommitRenderDurationMs: number;
}

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

const acceptedFiles: Record<UploadKind, string> = {
  cpu: ".cpuprofile,.json,application/json",
  reactProfile: ".json,application/json",
};

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)} s`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${Math.round(seconds % 60)} s`;
}

function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

function formatUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "";
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/** Compact "in / out (+ cached) [+ cost]" suffix shared by both usage readouts. */
function usageBreakdown(usage: TokenUsage): string {
  const parts = [`${formatTokens(usage.input)} in`, `${formatTokens(usage.output)} out`];
  if (usage.cacheRead > 0) parts.push(`${formatTokens(usage.cacheRead)} cached`);
  const cost = formatUsd(usage.costUsd);
  if (cost) parts.push(cost);
  return parts.join(" · ");
}

function errorMessageFrom(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

function SparklesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 13.6 8.4 19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6Z" />
      <path d="M19 3v4M21 5h-4M5 16v3M6.5 17.5h-3" />
    </svg>
  );
}

function HeaderIcon({ type }: { type: "history" | "settings" | "help" | "close" | "arrow" | "back" }) {
  const paths = {
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.15.38.36.72.65 1 .3.27.68.41 1.08.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 1 1 4.15 1.88C12.7 11.7 12 12.15 12 13.5M12 17h.01" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    back: <path d="M19 12H5m6 6-6-6 6-6" />,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type]}</svg>;
}

function ProfileSnapshot({ type, active }: { type: "cpu" | "react"; active: boolean }) {
  const isCpu = type === "cpu";
  const title = isCpu ? "Bottlenecks, slowest first" : "React issues";
  const summary = isCpu
    ? "2 bottlenecks · 8.13 s total"
    : "1 issue · 16 ms budget · 4 commits · 169.74 ms peak · 1 over budget";
  const usage = isCpu
    ? "analyzer · 6.1k tokens · 5.3k in · 711 out"
    : "analyzer · 20k tokens · 12k in · 403 out · 8.0k cached";
  const issueTitle = isCpu
    ? "toLocaleString date formatting dominates sorting inside getUserByUserName on _onFocus"
    : "HeavyActivityHeatmap mount stalls explore-details first paint by ~125 ms";
  const time = isCpu ? "2.05 s" : "125 ms";
  const share = isCpu ? "97% of group" : "74% of commit";
  const detail = isCpu
    ? "Native datePrototypeToLocaleStringHelper costs 2050 ms of self time, reached through arrayPrototypeSort inside getUserByUserName from the _onFocus dispatch."
    : "HeavyActivityHeatmap used 124.8 ms self time on its single mount, about 74% of the 169.7 ms commit that opened explore-details.";

  return (
    <article className={`signal-snapshot signal-snapshot-${type}${active ? " is-active" : ""}`} aria-label={`${title} example`}>
      {isCpu ? null : <span className="snapshot-kicker">Analysis results</span>}
      <h2>{title}</h2>
      <p className="snapshot-summary">{summary}</p>
      <p className="snapshot-usage">{usage}</p>
      <div className="snapshot-divider" />
      <section className="snapshot-issue">
        <div className="snapshot-issue-head">
          <span className="snapshot-rank">#1</span>
          <strong>{issueTitle}</strong>
          <span className="snapshot-budget">{isCpu ? "2.11 s" : "high · 170 ms"}</span>
        </div>
        <div className="snapshot-issue-body">
          <div className="snapshot-time-line">
            <span>{time}</span>
            <small>{share}</small>
          </div>
          <div className="snapshot-meter" aria-hidden="true"><span /></div>
          <p>{detail}</p>
        </div>
      </section>
    </article>
  );
}

function ProfileSnapshotGallery() {
  const [activeSnapshot, setActiveSnapshot] = useState<"cpu" | "react">("cpu");

  useEffect(() => {
    const interval = window.setInterval(() => {
      setActiveSnapshot((current) => current === "cpu" ? "react" : "cpu");
    }, 2000);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="signal-snapshot-gallery" aria-label="Example CPU and React analysis results">
      <ProfileSnapshot type="cpu" active={activeSnapshot === "cpu"} />
      <ProfileSnapshot type="react" active={activeSnapshot === "react"} />
    </div>
  );
}

function PromptActionButton({
  prompt,
  loading,
  copied,
  busy,
  onGenerate,
  onCopy,
}: {
  prompt?: string;
  loading: boolean;
  copied: boolean;
  busy: boolean;
  onGenerate: () => void;
  onCopy: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="prompt-action-button"
      disabled={loading || (!prompt && busy)}
      onClick={() => (prompt ? onCopy() : onGenerate())}
    >
      {loading ? <RozeniteLoader size={14} label="" /> : prompt ? (copied ? <Check /> : <Copy />) : <SparklesIcon />}
      {loading ? "Generating…" : prompt ? (copied ? "Copied!" : "Copy Prompt") : "Generate Prompt"}
    </Button>
  );
}

function TokenBreakdown({ usage }: { usage?: TokenUsage }) {
  if (!usage) return null;
  return (
    <p className="token-breakdown" title="Tokens consumed by the agent that generated this prompt">
      {formatTokens(usage.totalTokens)} tokens · {usageBreakdown(usage)}
    </p>
  );
}

const MAX_RESULT_CARDS = 3;

function issuePeakMs(issue: ReactIssue): number {
  return issue.commits.reduce((max, commit) => Math.max(max, commit.durationMs), 0);
}

/** One "hot path" row: a single function's share of a card's total time. */
interface HotPathRow {
  /** Recorded `path:line:column`, shown only when the frame named a real source file. */
  location?: string;
  ms?: number;
  percentLabel?: string;
  barPercent?: number;
  caption?: string;
}

interface HotPathCard {
  rows: HotPathRow[];
  footnote?: string;
}

function hotspotRows(hotspot: Hotspot): HotPathCard {
  const ranked = hotspot.functions
    .map((fn, index) => ({ fn, detail: hotspot.summary[index] }))
    .sort((a, b) => b.fn.selfTimeMs - a.fn.selfTimeMs);
  const shown = ranked.slice(0, MAX_RESULT_CARDS);
  const rows: HotPathRow[] = shown.map(({ fn, detail }) => ({
    location: fn.location,
    ms: fn.selfTimeMs,
    percentLabel: `${Math.round(fn.percentOfGroup)}% of group`,
    barPercent: fn.percentOfGroup,
    caption: detail,
  }));

  const attributedMs = ranked.reduce((sum, { fn }) => sum + fn.selfTimeMs, 0);
  const leftoverMs = hotspot.combinedTimeMs - attributedMs;
  const footnote = leftoverMs >= 1
    ? `+ ~${formatMs(leftoverMs)} other time not attributed to a named function`
    : undefined;

  return { rows, footnote };
}

function reactIssueRows(issue: ReactIssue): HotPathCard {
  const caption = issue.evidence.trim() || undefined;
  if (!issue.component && !caption) return { rows: [] };
  return {
    rows: [{
      ms: issue.selfTimeMs,
      percentLabel: issue.percentOfCommit !== undefined ? `${Math.round(issue.percentOfCommit)}% of commit` : undefined,
      barPercent: issue.percentOfCommit,
      caption,
    }],
  };
}

function AnalysisResultCard({
  rank,
  title,
  timeLabel,
  rows,
  footnote,
  prompt,
  usage,
  loading,
  error,
  copied,
  busy,
  onGenerate,
  onCopy,
}: {
  rank: number;
  title: string;
  timeLabel: string;
  rows: HotPathRow[];
  footnote?: string;
  prompt?: string;
  usage?: TokenUsage;
  loading: boolean;
  error?: string;
  copied: boolean;
  busy: boolean;
  onGenerate: () => void;
  onCopy: () => void;
}) {
  return (
    <article className="hotspot-card">
      <div className="hotspot-head">
        <span className="hotspot-rank">#{rank}</span>
        <div className="hotspot-heading-copy">
          <strong>{title}</strong>
        </div>
        <span className="hotspot-time">{timeLabel}</span>
      </div>
      {rows.length > 0 && (
        <div className="hot-path-rows">
          {rows.map((row, rowIndex) => (
            <div className="hot-path-row" key={rowIndex}>
              {row.location ? (
                <p className="row-location" title={row.location}>
                  <span className="row-location-label">file</span>
                  <code>{row.location}</code>
                </p>
              ) : null}
              {row.ms !== undefined && (
                <>
                  <div className="row-figure-line">
                    <span className="row-figure">{formatMs(row.ms)}</span>
                    {row.percentLabel ? <span className="row-share">{row.percentLabel}</span> : null}
                  </div>
                  <div className="row-bar-track" aria-hidden="true">
                    <span className="row-bar-fill" style={{ width: `${row.barPercent ?? 0}%` }} />
                  </div>
                </>
              )}
              {row.caption ? <p className="row-caption">{row.caption}</p> : null}
            </div>
          ))}
          {footnote ? <p className="hot-path-footnote">{footnote}</p> : null}
        </div>
      )}
      <div className="hotspot-footer">
        {error ? <p className="hotspot-prompt-error">{error}</p> : null}
        <div className="hotspot-actions">
          <PromptActionButton
            prompt={prompt}
            loading={loading}
            copied={copied}
            busy={busy}
            onGenerate={onGenerate}
            onCopy={onCopy}
          />
          <TokenBreakdown usage={usage} />
        </div>
      </div>
    </article>
  );
}

function ProfileIcon({ type }: { type: ProfileType }) {
  if (type === "javascript") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.75 4.75h10.5a2 2 0 0 1 2 2v10.5a2 2 0 0 1-2 2H6.75a2 2 0 0 1-2-2V6.75a2 2 0 0 1 2-2Z" />
        <path d="M9.5 9.25v5.1c0 1.1-.62 1.65-1.85 1.65M16.4 10.05c-.46-.54-1.06-.8-1.8-.8-.9 0-1.55.45-1.55 1.17 0 .7.5.99 1.6 1.36 1.16.39 1.85.85 1.85 1.95 0 1.34-1.07 2.27-2.62 2.27-.98 0-1.78-.32-2.4-.96" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="12" rx="9" ry="3.6" />
      <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)" />
      <circle cx="12" cy="12" r="1.6" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3.75A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V14.5" />
    </svg>
  );
}

function UploadPane({
  kind,
  title,
  detail,
  file,
  disabled,
  onFile,
}: {
  kind: UploadKind;
  title: string;
  detail: string;
  file?: File;
  disabled?: boolean;
  onFile: (file?: File) => void;
}) {
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    onFile(event.target.files?.[0]);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    onFile(event.dataTransfer.files?.[0]);
  };

  return (
    <label
      className={`upload-pane${isDragging && !disabled ? " is-dragging" : ""}${file ? " has-file" : ""}${disabled ? " is-disabled" : ""}`}
      htmlFor={disabled ? undefined : inputId}
      aria-disabled={disabled}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <input id={inputId} type="file" accept={acceptedFiles[kind]} disabled={disabled} onChange={handleChange} />
      <span className="upload-icon"><UploadIcon /></span>
      <span className="upload-title">{file ? file.name : title}</span>
      <span className="upload-detail">{file ? "Ready to analyze" : detail}</span>
      <span className="browse-button">{file ? "Replace file" : "Browse files"}</span>
    </label>
  );
}

const ROZENITE_THEME_KEY = "@rozenite/ui:theme";

export default function Home() {
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(ROZENITE_THEME_KEY);
      if (stored !== "light" && stored !== "dark") {
        localStorage.setItem(ROZENITE_THEME_KEY, "dark");
      }
    } catch {
      // Theme still applies for this session even if storage is unavailable.
    }
    const frame = requestAnimationFrame(() => setThemeReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  if (!themeReady) {
    return <div className="dark h-screen bg-background" />;
  }

  return <InspectorApp />;
}

function InspectorApp() {
  const [guideOpen, setGuideOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [autoSave, setAutoSave] = useState(true);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [profileType, setProfileType] = useState<ProfileType>("javascript");
  const [showWelcome, setShowWelcome] = useState(true);
  const [files, setFiles] = useState<Partial<Record<UploadKind, File>>>({});
  const [modelStatus, setModelStatus] = useState<ModelSettings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSettingsMessage, setModelSettingsMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  useEffect(() => {
    try { localStorage.removeItem("perf-ai.apex-api-key"); } catch { /* Storage may be disabled. */ }
    const controller = new AbortController();
    fetch("/api/model", { signal: controller.signal, cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((settings: ModelSettings) => {
        setModelStatus(settings);
        setSelectedProvider(settings.providerId ?? "");
        setSelectedModel(settings.modelId ?? "");
      })
      .catch(() => { if (!controller.signal.aborted) setModelStatus({ configured: false, providers: [], error: "Could not load model configuration. Reload the page." }); });
    return () => controller.abort();
  }, []);
  const refreshHistory = async () => {
    try { const response = await fetch("/api/analyses", { cache: "no-store" }); const data = await response.json(); setHistory(data.analyses ?? []); } catch { /* History is optional local state. */ }
  };
  useEffect(() => {
    void refreshHistory();
    fetch("/api/analysis-settings", { cache: "no-store" }).then(r => r.json()).then(data => setAutoSave(data.autoSave !== false)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!settingsOpen && !historyOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSettingsOpen(false);
      setHistoryOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (settingsOpen && settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [historyOpen, settingsOpen]);

  const [phase, setPhase] = useState<Phase>("upload");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [analyzedType, setAnalyzedType] = useState<ProfileType>("javascript");
  const [totalMs, setTotalMs] = useState(0);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [frameBudget, setFrameBudget] = useState("16");
  const [appliedBudget, setAppliedBudget] = useState(16);
  const [reactIssues, setReactIssues] = useState<ReactIssue[]>([]);
  const [reactSummary, setReactSummary] = useState<ReactSummary | null>(null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [promptUsages, setPromptUsages] = useState<Record<string, TokenUsage>>({});
  const [analyzerUsage, setAnalyzerUsage] = useState<TokenUsage | null>(null);
  const [promptLoadingId, setPromptLoadingId] = useState<string | null>(null);
  const [promptErrors, setPromptErrors] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSample, setIsSample] = useState(false);

  const updateFile = (kind: UploadKind, file?: File) => {
    setFiles((current) => ({ ...current, [kind]: file }));
  };

  const validBudget = frameBudget.trim() !== "" && Number.isFinite(Number(frameBudget)) && Number(frameBudget) > 0;
  const isReady = Boolean(
    (profileType === "javascript" ? files.cpu : files.reactProfile) && modelStatus?.configured && (profileType !== "react" || validBudget),
  );

  const handleAnalyze = async () => {
    const file = profileType === "javascript" ? files.cpu : files.reactProfile;
    if (!file) {
      setError(profileType === "javascript" ? "Add a CPU profile file first." : "Add a React profile file first.");
      setErrorDetail(null);
      return;
    }
    if (!modelStatus?.configured) {
      setError("Choose a provider and model in Analysis settings first.");
      setErrorDetail(null);
      return;
    }
    if (profileType === "react" && !validBudget) {
      setError("Enter a finite positive commit budget in milliseconds.");
      return;
    }
    setPhase("analyzing");
    setError(null);
    setErrorDetail(null);
    try {
      const form = new FormData();
      form.append("profile", file);
      if (profileType === "react") form.append("frameBudgetMs", frameBudget);
      const endpoint = profileType === "javascript" ? "/api/analyze" : "/api/analyze/react";
      const response = await fetch(endpoint, { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        analysisId?: string | null; saved?: boolean;
        totalMs?: number;
        hotspots?: Hotspot[];
        usage?: TokenUsage;
        summary?: ReactSummary;
        issues?: ReactIssue[];
        noIssue?: boolean;
        reasoning?: string;
        frameBudgetMs?: number;
      };
      if (!response.ok) {
        setError(data.error ?? `Analysis failed (${response.status}).`);
        setErrorDetail(data.detail ?? null);
        setPhase("upload");
        return;
      }

      setPrompts({});
      setPromptUsages({});
      setAnalyzerUsage(data.usage ?? null);
      setPromptErrors({});
      setCopiedId(null);
    setAnalyzedType(profileType);
    setSaved(data.saved === true);
    setIsSample(false);

      if (profileType === "react") {
        if (!Array.isArray(data.issues) || (data.issues.length > 0 && typeof data.reasoning !== "string") || data.noIssue !== (data.issues.length === 0)) {
          setError("The server did not return a valid React issue report. Check the dev server logs.");
          setPhase("upload");
          return;
        }
        if (data.issues.length > 0 && !data.analysisId) {
          setError("The server did not return an analysis id. Check the dev server logs.");
          setPhase("upload");
          return;
        }
        setAnalysisId(data.analysisId ?? null);
        setHotspots([]);
        setReactIssues(data.issues);
        setAppliedBudget(data.frameBudgetMs ?? Number(frameBudget));
        setReactSummary(data.summary ?? null);
        setTotalMs(data.summary?.totalCommitRenderDurationMs ?? 0);
        setPhase("results");
        void refreshHistory();
        return;
      }

      const result: AnalyzeResponse = {
        analysisId: data.analysisId ?? "",
        totalMs: data.totalMs ?? 0,
        hotspots: data.hotspots ?? [],
        usage: data.usage,
      };
      if (!result.analysisId) {
        setError("The server did not return an analysis id. Check the dev server logs.");
        setPhase("upload");
        return;
      }
      setAnalysisId(result.analysisId);
      setTotalMs(result.totalMs);
      setHotspots(result.hotspots);
      setReactSummary(null);
      setPhase("results");
      void refreshHistory();
    } catch (err) {
      setError(errorMessageFrom(err));
      setErrorDetail(null);
      setPhase("upload");
    }
  };

  const generatePrompt = async (id: string) => {
    if (!analysisId || prompts[id] || promptLoadingId) return;

    setPromptErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setCopiedId(null);
    setPromptLoadingId(id);
    try {
      const isReact = analyzedType === "react";
      const response = await fetch(isReact ? "/api/react-issue-prompt" : "/api/hotspot-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isReact ? { analysisId, issueId: id } : { analysisId, hotspotId: id }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; prompt?: string; usage?: TokenUsage };
      if (!response.ok || !data.prompt) {
        throw new Error(data.error ?? `Prompt generation failed (${response.status}).`);
      }
      setPrompts((current) => ({ ...current, [id]: data.prompt as string }));
      if (data.usage) {
        const usage = data.usage;
        setPromptUsages((current) => ({ ...current, [id]: usage }));
      }
    } catch (err) {
      setPromptErrors((current) => ({ ...current, [id]: errorMessageFrom(err) }));
    } finally {
      setPromptLoadingId((current) => (current === id ? null : current));
    }
  };

  const copyPrompt = async (id: string) => {
    const text = prompts[id];
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 2000);
  };

  const resetToUpload = () => {
    setPhase("upload");
    setError(null);
    setErrorDetail(null);
    setAnalysisId(null);
    setAnalyzedType("javascript");
    setHotspots([]);
    setReactSummary(null);
    setReactIssues([]);
    setPrompts({});
    setPromptUsages({});
    setAnalyzerUsage(null);
    setPromptLoadingId(null);
    setPromptErrors({});
    setCopiedId(null);
    setSaved(false);
    setIsSample(false);
  };

  const saveCurrentAnalysis = async () => {
    if (!analysisId || saved) return;
    const response = await fetch("/api/analyses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysisId }) });
    if (response.ok) { setSaved(true); void refreshHistory(); }
  };
  const selectHistory = async (id: string) => {
    const response = await fetch(`/api/analyses/${id}`, { cache: "no-store" });
    if (!response.ok) return;
    const { analysis } = await response.json() as { analysis: SavedAnalysis };
    setAnalysisId(analysis.id); setAnalyzedType(analysis.profileType === "react" ? "react" : "javascript");
    setTotalMs(analysis.totalMs); setHotspots(analysis.hotspots ?? []); setReactIssues(analysis.reactIssues ?? []);
    setPrompts(analysis.prompts ?? {}); setPromptUsages(analysis.promptUsage ?? {}); setAnalyzerUsage(analysis.usage ?? null);
    setReactSummary(null); setSaved(true); setPhase("results"); setHistoryOpen(false);
    setIsSample(false);
  };
  const deleteHistory = async (id: string) => {
    if (!window.confirm("Delete this saved analysis?")) return;
    if ((await fetch(`/api/analyses/${id}`, { method: "DELETE" })).ok) { if (id === analysisId) setSaved(false); void refreshHistory(); }
  };
  const updateAutoSave = async (enabled: boolean) => {
    setAutoSave(enabled);
    await fetch("/api/analysis-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoSave: enabled }) });
  };
  const providerModels = modelStatus?.providers.find(provider => provider.id === selectedProvider)?.models ?? [];
  const selectedProviderSettings = modelStatus?.providers.find(provider => provider.id === selectedProvider);
  const updateProvider = (provider: string) => {
    setSelectedProvider(provider);
    setSelectedModel(provider === modelStatus?.providerId ? modelStatus.modelId ?? "" : "");
    setApiKey("");
    setModelSettingsMessage(null);
  };
  const updateModel = (model: string) => {
    setSelectedModel(model);
    setApiKey("");
    setModelSettingsMessage(null);
  };
  const saveModelSettings = async () => {
    if (!selectedProvider || !selectedModel || modelSaving) return;
    setModelSaving(true);
    setModelSettingsMessage(null);
    try {
      const response = await fetch("/api/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider, model: selectedModel, ...(apiKey.trim() ? { apiKey } : {}) }),
      });
      const data = await response.json() as ModelSettings & { error?: string };
      if (!response.ok) throw new Error(data.error || `Could not save model settings (${response.status}).`);
      setModelStatus(data);
      setSelectedProvider(data.providerId ?? selectedProvider);
      setSelectedModel(data.modelId ?? selectedModel);
      setApiKey("");
      setModelSettingsMessage({ tone: "success", text: "Model and API key saved on this device." });
    } catch (err) {
      setModelSettingsMessage({ tone: "error", text: errorMessageFrom(err) });
    } finally {
      setModelSaving(false);
    }
  };
  const clearModelSettings = async () => {
    if (modelSaving || !window.confirm("Clear the selected model and all saved provider API keys from this device?")) return;
    setModelSaving(true);
    setModelSettingsMessage(null);
    try {
      const response = await fetch("/api/model", { method: "DELETE" });
      const data = await response.json() as ModelSettings & { error?: string };
      if (!response.ok) throw new Error(data.error || `Could not clear model settings (${response.status}).`);
      setModelStatus(data);
      setSelectedProvider("");
      setSelectedModel("");
      setApiKey("");
      setModelSettingsMessage({ tone: "success", text: "Saved model configuration cleared." });
    } catch (err) {
      setModelSettingsMessage({ tone: "error", text: errorMessageFrom(err) });
    } finally {
      setModelSaving(false);
    }
  };
  const loadCpuSample = async () => {
    const response = await fetch("/api/samples/cpu", { cache: "force-cache" });
    if (!response.ok) return;
    const { analysis } = await response.json() as { analysis: SavedAnalysis };
    setAnalysisId(analysis.id); setAnalyzedType("javascript"); setTotalMs(analysis.totalMs);
    setHotspots(analysis.hotspots); setReactIssues([]); setReactSummary(null);
    setPrompts({}); setPromptUsages({}); setAnalyzerUsage(analysis.usage); setSaved(true); setIsSample(true); setPhase("results");
  };
  const loadReactSample = async () => {
    const response = await fetch("/api/samples/react", { cache: "force-cache" });
    if (!response.ok) return;
    const { analysis, summary } = await response.json() as { analysis: SavedAnalysis; summary: ReactSummary & { frameBudgetMs: number } };
    setAnalysisId(analysis.id); setAnalyzedType("react"); setTotalMs(analysis.totalMs);
    setHotspots([]); setReactIssues(analysis.reactIssues); setReactSummary(summary); setAppliedBudget(summary.frameBudgetMs);
    setPrompts({}); setPromptUsages({}); setAnalyzerUsage(analysis.usage); setSaved(true); setIsSample(true); setPhase("results");
  };

  const reactIssueCards = reactIssues.slice(0, MAX_RESULT_CARDS);
  const analyzing = phase === "analyzing";

  return (
    <PluginShell>
      <PluginHeader>
        <PluginHeader.Title className="brand" render={<div />}>
          <Image src="/callstack-logo.png" alt="" width={30} height={30} priority />
          <span><span className="brand-name">Perf AI</span><small>by Callstack</small></span>
        </PluginHeader.Title>
        <PluginHeader.Actions>
          <Button className="header-action" type="button" size="sm" variant="ghost" onClick={() => { setSettingsOpen(false); setHistoryOpen(true); }}>
            <HeaderIcon type="history" /> Analyses
          </Button>
          <div className="settings-anchor" ref={settingsRef}>
            <Button className={`header-action${settingsOpen ? " is-active" : ""}`} type="button" size="sm" variant="ghost" aria-expanded={settingsOpen} aria-haspopup="dialog" onClick={() => setSettingsOpen(open => !open)}>
              <HeaderIcon type="settings" /> Settings
            </Button>
            {settingsOpen && (
              <div className="settings-popover" role="dialog" aria-label="Analysis settings">
                <div className="popover-arrow" />
                <div className="settings-popover-scroll">
                <div className="settings-popover-head">
                  <div><strong>Analysis settings</strong><small>Preferences are saved on this device.</small></div>
                  <button className="icon-button" aria-label="Close analysis settings" onClick={() => setSettingsOpen(false)}><HeaderIcon type="close" /></button>
                </div>
                <div className="model-settings-form">
                  <label htmlFor="analysis-provider">Provider</label>
                  <select id="analysis-provider" value={selectedProvider} onChange={event => updateProvider(event.target.value)} disabled={!modelStatus || modelSaving}>
                    <option value="">Select a provider</option>
                    {modelStatus?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                  {selectedProvider && (
                    <>
                      <label htmlFor="analysis-model">Model</label>
                      <select id="analysis-model" value={selectedModel} onChange={event => updateModel(event.target.value)} disabled={modelSaving}>
                        <option value="">Select a model</option>
                        {providerModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                      </select>
                    </>
                  )}
                  {selectedModel && (
                    <>
                      <label htmlFor="analysis-api-key">API key</label>
                      <input
                        id="analysis-api-key"
                        type="password"
                        value={apiKey}
                        autoComplete="new-password"
                        placeholder={selectedProviderSettings?.keyConfigured ? "Saved key (enter to replace)" : "Enter API key"}
                        onChange={event => { setApiKey(event.target.value); setModelSettingsMessage(null); }}
                        disabled={modelSaving}
                      />
                      <small className="model-key-help">
                        {selectedProviderSettings?.keyConfigured ? "A key is already saved for this provider." : "Required to use this provider."} The key stays in the local Perf AI configuration.
                      </small>
                      <Button
                        className="model-save-button"
                        type="button"
                        size="sm"
                        onClick={() => void saveModelSettings()}
                        disabled={modelSaving || (!selectedProviderSettings?.keyConfigured && !apiKey.trim())}
                      >
                        {modelSaving ? "Saving…" : "Save model settings"}
                      </Button>
                    </>
                  )}
                  {modelSettingsMessage && <p className={`model-settings-message ${modelSettingsMessage.tone}`} role="status">{modelSettingsMessage.text}</p>}
                  {(modelStatus?.configured || modelStatus?.providers.some(provider => provider.keyConfigured)) && (
                    <button className="clear-model-button" type="button" disabled={modelSaving} onClick={() => void clearModelSettings()}>
                      Clear saved model and API keys
                    </button>
                  )}
                </div>
                <label className="autosave-toggle">
                  <span className="toggle-copy"><strong>Save analyses automatically</strong><small>Keep completed reports in your local analysis history.</small></span>
                  <input type="checkbox" checked={autoSave} onChange={event => void updateAutoSave(event.target.checked)} />
                  <span className="toggle-control" aria-hidden="true"><span /></span>
                </label>
                <p className="settings-privacy">Raw profile uploads are never retained.</p>
                </div>
              </div>
            )}
          </div>
          <Button className="header-action help-action" type="button" size="sm" variant="ghost" onClick={() => setGuideOpen(true)}>
            <HeaderIcon type="help" /> Guide
          </Button>
          <PluginHeader.ThemeSwitcher />
        </PluginHeader.Actions>
      </PluginHeader>
      <HowToUseGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
      {historyOpen && (
        <div className="drawer-overlay">
          <button className="drawer-backdrop" aria-label="Close saved analyses" onClick={() => setHistoryOpen(false)} />
          <aside className="analysis-drawer" role="dialog" aria-modal="true" aria-label="Saved analyses">
            <div className="drawer-head">
              <div><span className="drawer-kicker">Your workspace</span><strong>Saved analyses</strong><small>{history.length} saved report{history.length === 1 ? "" : "s"}</small></div>
              <button className="icon-button" aria-label="Close saved analyses" onClick={() => setHistoryOpen(false)}><HeaderIcon type="close" /></button>
            </div>
            {history.length === 0 ? (
              <div className="history-empty"><HeaderIcon type="history" /><strong>No saved analyses yet</strong><p>Completed reports will appear here when automatic saving is enabled.</p></div>
            ) : (
              <div className="history-list">{history.map(item => (
                <div className="history-item" key={item.id}>
                  <button onClick={() => void selectHistory(item.id)}>
                    <span className={`history-kind ${item.profileType}`}>{item.profileType === "cpu" ? "JS" : "⚛"}</span>
                    <span className="history-copy"><strong>{item.title}</strong><small>{item.profileType === "cpu" ? "CPU profile" : "React profile"} · {new Date(item.createdAt).toLocaleDateString()}</small><span>{item.issueCount} issue{item.issueCount === 1 ? "" : "s"} <i /> {formatTokens(item.totalTokens)} tokens</span></span>
                    <HeaderIcon type="arrow" />
                  </button>
                  <button aria-label={`Delete ${item.title}`} className="history-delete" onClick={() => void deleteHistory(item.id)}>×</button>
                </div>
              ))}</div>
            )}
          </aside>
        </div>
      )}

      <PluginShell.Body>
      <section className={`workspace${phase === "results" ? " results" : ""}`}>
        {(phase === "upload" || phase === "analyzing") && (
          <>
            {showWelcome ? (
              <>
            <div className="hero-stage">
              <div className="intro intro-copy">
                <h1>Find the code that makes your app feel slow</h1>
                <p>Turn profiler traces into a focused list of bottlenecks</p>
                <div className="intro-actions">
                  <Button className="get-started-button" size="lg" onClick={() => setShowWelcome(false)}>
                    Get Started <HeaderIcon type="arrow" />
                  </Button>
                  <div className="platform-list" aria-label="Supported platforms">
                    <span><ProfileIcon type="react" />React</span>
                    <span><ProfileIcon type="javascript" />JavaScript</span>
                    <span><ProfileIcon type="react" />React Native</span>
                  </div>
                </div>
              </div>
              <ProfileSnapshotGallery />
            </div>
              </>
            ) : (
              <>

            <div className="workflow-label"><span>1</span><div><strong>Choose a profile type</strong><small>Select the tool you used to capture performance.</small></div></div>
            <div className="profile-options" role="radiogroup" aria-label="Profile type" aria-disabled={analyzing}>
              <button type="button" role="radio" aria-checked={profileType === "javascript"} disabled={analyzing} className={`profile-option${profileType === "javascript" ? " selected" : ""}`} onClick={() => setProfileType("javascript")}>
                <span className="profile-icon"><ProfileIcon type="javascript" /></span>
                <span className="option-copy"><strong>JavaScript CPU</strong><small>Find slow functions and heavy execution paths</small><em>.cpuprofile · Chrome JSON</em></span>
                <span className="radio-indicator" />
              </button>

              <button type="button" role="radio" aria-checked={profileType === "react"} disabled={analyzing} className={`profile-option${profileType === "react" ? " selected" : ""}`} onClick={() => setProfileType("react")}>
                <span className="profile-icon"><ProfileIcon type="react" /></span>
                <span className="option-copy"><strong>React components</strong><small>Find expensive renders and component updates</small><em>React DevTools JSON</em></span>
                <span className="radio-indicator" />
              </button>
            </div>

            <div className="sample-callout">
              <span>Just exploring?</span>
              <button type="button" onClick={() => void (profileType === "javascript" ? loadCpuSample() : loadReactSample())}>Open a sample {profileType === "javascript" ? "CPU" : "React"} analysis <HeaderIcon type="arrow" /></button>
            </div>

            <section className="upload-section" aria-live="polite">
              <div className="section-heading">
                <div><span className="section-step">2</span><span><h2>Add your profile</h2><small>Your file is processed locally and never uploaded.</small></span></div>
                <p>Required</p>
              </div>

              <div className="upload-grid single">
                {profileType === "javascript" ? (
                  <UploadPane kind="cpu" title="JavaScript CPU profile" detail="Drop a .cpuprofile or Chrome Performance .json here" file={files.cpu} disabled={analyzing} onFile={(file) => updateFile("cpu", file)} />
                ) : (
                  <UploadPane kind="reactProfile" title="React component profile" detail="Drop a React DevTools profiling .json file here" file={files.reactProfile} disabled={analyzing} onFile={(file) => updateFile("reactProfile", file)} />
                )}
              </div>

              {profileType === "react" && (
                <div className="react-budget-field">
                  <label htmlFor="react-frame-budget">Commit budget (ms)</label>
                  <input id="react-frame-budget" type="number" step="any" value={frameBudget}
                    disabled={analyzing}
                    aria-invalid={!validBudget} aria-describedby="react-budget-help"
                    onChange={event => setFrameBudget(event.target.value)} />
                  <p id="react-budget-help">Defaults to 16 ms. Use a lower budget, such as 8.33 ms, for a higher refresh-rate target.</p>
                </div>
              )}

              <div className="key-field">
                <Text>{modelStatus === null ? "Loading model…" : modelStatus.configured
                  ? `Model: ${modelStatus.provider} / ${modelStatus.model}`
                  : modelStatus.error || "Choose a model in Analysis settings."}</Text>
                  <br />
                <Text className="italic text-muted-foreground">Change the provider or model from Analysis settings.</Text>
              </div>
            </section>

            {error && (
              <Alert tone="danger" className="mt-4">
                <Alert.Title>{error}</Alert.Title>
                {errorDetail && (
                  <Alert.Description>
                    <details className="error-detail-wrap">
                      <summary>What the agent returned</summary>
                      <pre className="error-detail">{errorDetail}</pre>
                    </details>
                  </Alert.Description>
                )}
              </Alert>
            )}

            <div className="action-row">
              <p>Your profile stays on this device and is analyzed via your configured model.</p>
              <Button className="analyze-profile-button" size="lg" disabled={!isReady || analyzing} onClick={() => void handleAnalyze()}>
                {phase === "analyzing" ? (
                  <>
                    <RozeniteLoader size={16} label="" />
                    Analyzing profile…
                  </>
                ) : (
                  <>
                    Analyze profile
                    <ArrowRight />
                  </>
                )}
              </Button>
            </div>
              </>
            )}
          </>
        )}

        {phase === "results" && analyzedType === "react" && (
          <>
            <button className="results-back" type="button" onClick={resetToUpload}><HeaderIcon type="back" /> Back to new analysis</button>
            <div className="results-header">
              <div className="intro">
                <span className="eyebrow">Analysis results</span>
                <h1 className="results-title">React issues</h1>
                <p>
                  {reactIssues.length} issue{reactIssues.length === 1 ? "" : "s"} · {appliedBudget} ms budget
                  {reactSummary ? ` · ${reactSummary.commitCount} commits · ${reactSummary.peakCommitDurationMs ?? 0} ms peak · ${reactSummary.commitsOverBudget} over budget` : ""}
                  {reactSummary && reactSummary.omittedEvidenceCommitCount > 0
                    ? ` · ${reactSummary.omittedEvidenceCommitCount} commits omitted from detailed analysis`
                    : ""}
                </p>
                {analyzerUsage && (
                  <p className="usage-line" title="Tokens consumed by the analyzer agent for this analysis">
                    analyzer · {formatTokens(analyzerUsage.totalTokens)} tokens · {usageBreakdown(analyzerUsage)}
                  </p>
                )}
              </div>
              <div className="result-actions">{!saved && analysisId ? <Button variant="outline" onClick={() => void saveCurrentAnalysis()}>Save analysis</Button> : null}</div>
            </div>

            <div className="hotspot-list">
              {reactIssueCards.map((issue, index) => {
                const peakMs = issuePeakMs(issue);
                const { rows, footnote } = reactIssueRows(issue);
                return (
                  <AnalysisResultCard
                    key={issue.id}
                    rank={index + 1}
                    title={issue.summary}
                    timeLabel={`${issue.severity} · ${formatMs(peakMs)}`}
                    rows={rows}
                    footnote={footnote}
                    prompt={prompts[issue.id]}
                    usage={promptUsages[issue.id]}
                    loading={promptLoadingId === issue.id}
                    error={promptErrors[issue.id]}
                    copied={copiedId === issue.id}
                    busy={isSample || promptLoadingId !== null}
                    onGenerate={() => void generatePrompt(issue.id)}
                    onCopy={() => void copyPrompt(issue.id)}
                  />
                );
              })}
            </div>
          </>
        )}

        {phase === "results" && analyzedType === "javascript" && (
          <>
            <button className="results-back" type="button" onClick={resetToUpload}><HeaderIcon type="back" /> Back to new analysis</button>
            <div className="results-header">
              <div className="intro">
                <span className="eyebrow">Analysis results</span>
                <h1 className="results-title">Bottlenecks, slowest first</h1>
                <p>
                  {hotspots.length} bottleneck{hotspots.length === 1 ? "" : "s"} · {formatMs(totalMs)} total
                </p>
                {analyzerUsage && (
                  <p className="usage-line" title="Tokens consumed by the analyzer agent for this analysis">
                    analyzer · {formatTokens(analyzerUsage.totalTokens)} tokens · {usageBreakdown(analyzerUsage)}
                  </p>
                )}
              </div>
              <div className="result-actions">{!saved && analysisId ? <Button variant="outline" onClick={() => void saveCurrentAnalysis()}>Save analysis</Button> : null}</div>
            </div>

            <div className="hotspot-list">
              {hotspots.map((hotspot, index) => {
                const { rows, footnote } = hotspotRows(hotspot);
                return (
                <AnalysisResultCard
                  key={hotspot.id}
                  rank={index + 1}
                  title={hotspot.title}
                  timeLabel={formatMs(hotspot.combinedTimeMs)}
                  rows={rows}
                  footnote={footnote}
                  prompt={prompts[hotspot.id]}
                  usage={promptUsages[hotspot.id]}
                  loading={promptLoadingId === hotspot.id}
                  error={promptErrors[hotspot.id]}
                  copied={copiedId === hotspot.id}
                  busy={isSample || promptLoadingId !== null}
                  onGenerate={() => void generatePrompt(hotspot.id)}
                  onCopy={() => void copyPrompt(hotspot.id)}
                />
                );
              })}
            </div>
          </>
        )}
      </section>
      </PluginShell.Body>
    </PluginShell>
  );
}
