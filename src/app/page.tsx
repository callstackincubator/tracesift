"use client";

import { ChangeEvent, DragEvent, useEffect, useId, useState } from "react";
import {
  Alert,
  ArrowRight,
  Button,
  Check,
  Copy,
  IndicatorDot,
  PluginHeader,
  PluginShell,
  RozeniteLoader,
  Text,
} from "@rozenite/ui";

import type { Hotspot } from "@/lib/analysis";
import type { ReactIssue } from "@/lib/react-analyzer";

type ProfileType = "javascript" | "react";
type UploadKind = "cpu" | "reactProfile";
type Phase = "upload" | "analyzing" | "results";

interface AnalyzeResponse {
  analysisId: string;
  totalMs: number;
  hotspots: Hotspot[];
  usage?: TokenUsage;
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

function shortFunctionName(title: string): string {
  const cut = title.indexOf(" (");
  return cut > 0 ? title.slice(0, cut) : title;
}

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

function hotspotColumns(hotspot: Hotspot): Array<{ chip?: string; chipTitle?: string; detail?: string }> {
  console.log(hotspot);
  return hotspot.functions
    .map((fn, index) => ({ fn, detail: hotspot.summary[index] }))
    .sort((a, b) => b.fn.selfTimeMs - a.fn.selfTimeMs)
    .slice(0, MAX_RESULT_CARDS)
    .map(({ fn, detail }) => ({
      chip: shortFunctionName(fn.title),
      chipTitle: fn.title,
      detail: detail,
    }));
}

function reactIssueColumns(issue: ReactIssue): Array<{ chip?: string; chipTitle?: string; detail?: string }> {
  const chip = issue.component || undefined;
  const detail = issue.evidence.trim() || undefined;
  if (!chip && !detail) return [];
  return [{
    chip,
    chipTitle: issue.component ? `${issue.component} (${issue.componentId})` : undefined,
    detail,
  }];
}

function AnalysisResultCard({
  rank,
  title,
  timeLabel,
  barPercent,
  columns,
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
  barPercent: number;
  columns: Array<{ chip?: string; chipTitle?: string; detail?: string }>;
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
        <span className="hotspot-rank">{rank}</span>
        <strong>{title}</strong>
        <span className="hotspot-time">{timeLabel}</span>
      </div>
      <div className="hotspot-bar" aria-hidden="true">
        <span style={{ width: `${barPercent}%` }} />
      </div>
      {columns.length > 0 && (
        <div className={`hotspot-columns count-${Math.min(columns.length, MAX_RESULT_CARDS)}`}>
          {columns.map((column, columnIndex) => (
            <div className="hotspot-column" key={columnIndex}>
              {column.chip ? (
                <span className="function-chip" title={column.chipTitle ?? column.chip}>
                  {column.chip}
                </span>
              ) : null}
              {column.detail ? <span className="column-detail">{column.detail}</span> : null}
            </div>
          ))}
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
  onFile,
}: {
  kind: UploadKind;
  title: string;
  detail: string;
  file?: File;
  onFile: (file?: File) => void;
}) {
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onFile(event.target.files?.[0]);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    onFile(event.dataTransfer.files?.[0]);
  };

  return (
    <label
      className={`upload-pane${isDragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
      htmlFor={inputId}
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <input id={inputId} type="file" accept={acceptedFiles[kind]} onChange={handleChange} />
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
  const [profileType, setProfileType] = useState<ProfileType>("javascript");
  const [files, setFiles] = useState<Partial<Record<UploadKind, File>>>({});
  const [modelStatus, setModelStatus] = useState<{ configured: boolean; provider?: string; model?: string; error?: string } | null>(null);
  useEffect(() => {
    try { localStorage.removeItem("perf-ai.apex-api-key"); } catch { /* Storage may be disabled. */ }
    const controller = new AbortController();
    fetch("/api/model", { signal: controller.signal, cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then(setModelStatus)
      .catch(() => { if (!controller.signal.aborted) setModelStatus({ configured: false, error: "Could not load model configuration. Reload the page." }); });
    return () => controller.abort();
  }, []);

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
      setError("Run perf-ai model, then restart the server.");
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
        analysisId?: string | null;
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
  };

  const maxPercent = hotspots.length > 0 ? Math.max(...hotspots.map((hotspot) => hotspot.percentOfTotal)) : 0;
  const reactIssueCards = reactIssues.slice(0, MAX_RESULT_CARDS);
  const maxReactPeakMs = reactIssueCards.length > 0 ? Math.max(...reactIssueCards.map(issuePeakMs)) : 0;

  return (
    <PluginShell>
      <PluginHeader>
        <PluginHeader.Title className="brand" render={<div />}>
          <span className="brand-mark" aria-hidden="true"><ProfileIcon type="react" /></span>
          RN Profile Inspector
        </PluginHeader.Title>
        <PluginHeader.Actions>
          <Text variant="caption" className="local-badge">
            <IndicatorDot tone="success" size="lg" />
            Runs locally · AI-assisted
          </Text>
          <PluginHeader.ThemeSwitcher />
        </PluginHeader.Actions>
      </PluginHeader>

      <PluginShell.Body>
      <section className={`workspace${phase === "results" ? " results" : ""}`}>
        {(phase === "upload" || phase === "analyzing") && (
          <>
            <div className="intro">
              <span className="eyebrow">React Native performance</span>
              <h1>What would you like to analyze?</h1>
              <p>Choose a profile type, then add the profile captured from your React Native app.</p>
            </div>

            <div className="profile-options" role="radiogroup" aria-label="Profile type">
              <button type="button" role="radio" aria-checked={profileType === "javascript"} className={`profile-option${profileType === "javascript" ? " selected" : ""}`} onClick={() => setProfileType("javascript")}>
                <span className="profile-icon"><ProfileIcon type="javascript" /></span>
                <span className="option-copy"><strong>JavaScript CPU profile</strong><small>Inspect call stacks and JavaScript execution time</small></span>
                <span className="radio-indicator" />
              </button>

              <button type="button" role="radio" aria-checked={profileType === "react"} className={`profile-option${profileType === "react" ? " selected" : ""}`} onClick={() => setProfileType("react")}>
                <span className="profile-icon"><ProfileIcon type="react" /></span>
                <span className="option-copy"><strong>React component profile</strong><small>Find expensive renders and component updates</small></span>
                <span className="radio-indicator" />
              </button>
            </div>

            <section className="upload-section" aria-live="polite">
              <div className="section-heading">
                <div><h2>Add a profile</h2></div>
                <p>required</p>
              </div>

              <div className="upload-grid single">
                {profileType === "javascript" ? (
                  <UploadPane kind="cpu" title="JavaScript CPU profile" detail="Drop a .cpuprofile or Chrome Performance .json here" file={files.cpu} onFile={(file) => updateFile("cpu", file)} />
                ) : (
                  <UploadPane kind="reactProfile" title="React component profile" detail="Drop a React DevTools profiling .json file here" file={files.reactProfile} onFile={(file) => updateFile("reactProfile", file)} />
                )}
              </div>

              {profileType === "react" && (
                <div className="react-budget-field">
                  <label htmlFor="react-frame-budget">Commit budget (ms)</label>
                  <input id="react-frame-budget" type="number" step="any" value={frameBudget}
                    aria-invalid={!validBudget} aria-describedby="react-budget-help"
                    onChange={event => setFrameBudget(event.target.value)} />
                  <p id="react-budget-help">Defaults to 16 ms. Use a lower budget, such as 8.33 ms, for a higher refresh-rate target.</p>
                </div>
              )}

              <div className="key-field">
                <Text>{modelStatus === null ? "Loading model…" : modelStatus.configured
                  ? `Model: ${modelStatus.provider} / ${modelStatus.model}`
                  : modelStatus.error || "Run perf-ai model, then restart the server."}</Text>
                  <br />
                <Text className="italic text-muted-foreground">Change models with <code>perf-ai model</code> and restart the server.</Text>
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
              <p>Your profile stays on this device and is analyzed locally.</p>
              <Button size="lg" disabled={!isReady || phase === "analyzing"} onClick={() => void handleAnalyze()}>
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

        {phase === "results" && analyzedType === "react" && (
          <>
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
              <Button tone="primary" variant="outline" onClick={resetToUpload}>New analysis</Button>
            </div>

            <div className="hotspot-list">
              {reactIssueCards.map((issue, index) => {
                const peakMs = issuePeakMs(issue);
                return (
                  <AnalysisResultCard
                    key={issue.id}
                    rank={index + 1}
                    title={issue.summary}
                    timeLabel={`${issue.severity} · ${formatMs(peakMs)}`}
                    barPercent={maxReactPeakMs > 0 ? Math.max(4, (peakMs / maxReactPeakMs) * 100) : 0}
                    columns={reactIssueColumns(issue)}
                    prompt={prompts[issue.id]}
                    usage={promptUsages[issue.id]}
                    loading={promptLoadingId === issue.id}
                    error={promptErrors[issue.id]}
                    copied={copiedId === issue.id}
                    busy={promptLoadingId !== null}
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
              <Button tone="primary" variant="outline" onClick={resetToUpload}>New analysis</Button>
            </div>

            <div className="hotspot-list">
              {hotspots.map((hotspot, index) => (
                <AnalysisResultCard
                  key={hotspot.id}
                  rank={index + 1}
                  title={hotspot.title}
                  timeLabel={formatMs(hotspot.combinedTimeMs)}
                  barPercent={maxPercent > 0 ? Math.max(4, (hotspot.percentOfTotal / maxPercent) * 100) : 0}
                  columns={hotspotColumns(hotspot)}
                  prompt={prompts[hotspot.id]}
                  usage={promptUsages[hotspot.id]}
                  loading={promptLoadingId === hotspot.id}
                  error={promptErrors[hotspot.id]}
                  copied={copiedId === hotspot.id}
                  busy={promptLoadingId !== null}
                  onGenerate={() => void generatePrompt(hotspot.id)}
                  onCopy={() => void copyPrompt(hotspot.id)}
                />
              ))}
            </div>
          </>
        )}
      </section>
      </PluginShell.Body>
    </PluginShell>
  );
}
