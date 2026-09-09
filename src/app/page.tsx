"use client";

import { ChangeEvent, DragEvent, useEffect, useId, useState } from "react";
import {
  Alert,
  ArrowRight,
  Badge,
  Button,
  IndicatorDot,
  PluginHeader,
  PluginShell,
  RozeniteLoader,
  Text,
} from "@rozenite/ui";

import type { Hotspot } from "@/lib/analysis";

type ProfileType = "javascript" | "react";
type UploadKind = "cpu" | "reactProfile";
type Phase = "upload" | "analyzing" | "results";

interface AnalyzeResponse {
  analysisId: string;
  totalMs: number;
  hotspots: Hotspot[];
  usage?: TokenUsage;
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
  const [totalMs, setTotalMs] = useState(0);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [promptUsages, setPromptUsages] = useState<Record<string, TokenUsage>>({});
  const [analyzerUsage, setAnalyzerUsage] = useState<TokenUsage | null>(null);
  const [promptLoadingId, setPromptLoadingId] = useState<string | null>(null);
  const [promptErrors, setPromptErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const updateFile = (kind: UploadKind, file?: File) => {
    setFiles((current) => ({ ...current, [kind]: file }));
  };

  const isReady = profileType === "javascript"
    ? Boolean(files.cpu && modelStatus?.configured)
    : false;

  const handleAnalyze = async () => {
    if (!files.cpu) {
      setError("Add a CPU profile file first.");
      setErrorDetail(null);
      return;
    }
    if (!modelStatus?.configured) {
      setError("Run perf-ai model, then restart the server.");
      setErrorDetail(null);
      return;
    }
    setPhase("analyzing");
    setError(null);
    setErrorDetail(null);
    try {
      const form = new FormData();
      form.append("profile", files.cpu);

      const response = await fetch("/api/analyze", { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        analysisId?: string;
        totalMs?: number;
        hotspots?: Hotspot[];
        usage?: TokenUsage;
      };
      if (!response.ok) {
        setError(data.error ?? `Analysis failed (${response.status}).`);
        setErrorDetail(data.detail ?? null);
        setPhase("upload");
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
      setSelectedId(result.hotspots[0]?.id ?? null);
      setPrompts({});
      setPromptUsages({});
      setAnalyzerUsage(result.usage ?? null);
      setPromptErrors({});
      setCopied(false);
      setPhase("results");
    } catch (err) {
      setError(errorMessageFrom(err));
      setErrorDetail(null);
      setPhase("upload");
    }
  };

  const selectHotspot = (id: string) => {
    setSelectedId(id);
    setCopied(false);
  };

  const generatePrompt = async (id: string) => {
    if (!analysisId || prompts[id] || promptLoadingId) return;

    setPromptErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setCopied(false);
    setPromptLoadingId(id);
    try {
      const response = await fetch("/api/hotspot-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId, hotspotId: id }),
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

  const copyPrompt = async () => {
    if (!selectedId) return;
    const text = prompts[selectedId];
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
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const resetToUpload = () => {
    setPhase("upload");
    setError(null);
    setErrorDetail(null);
    setAnalysisId(null);
    setHotspots([]);
    setSelectedId(null);
    setPrompts({});
    setPromptUsages({});
    setAnalyzerUsage(null);
    setPromptLoadingId(null);
    setPromptErrors({});
    setCopied(false);
  };

  const selected = hotspots.find((hotspot) => hotspot.id === selectedId);
  const selectedPromptUsage = selected ? promptUsages[selected.id] : undefined;
  const maxPercent = hotspots.length > 0 ? Math.max(...hotspots.map((hotspot) => hotspot.percentOfTotal)) : 0;

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
      <section className="workspace">
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
                <Badge tone="neutral" variant="soft">coming soon</Badge>
              </button>
            </div>

            <section className="upload-section" aria-live="polite">
              <div className="section-heading">
                <div><span className="step-number">2</span><h2>Add profile file</h2></div>
                <p>One file required</p>
              </div>

              <div className="upload-grid single">
                {profileType === "javascript" ? (
                  <UploadPane kind="cpu" title="JavaScript CPU profile" detail="Drop a .cpuprofile or Chrome Performance .json here" file={files.cpu} onFile={(file) => updateFile("cpu", file)} />
                ) : (
                  <UploadPane kind="reactProfile" title="React component profile" detail="Drop a React DevTools profiling .json file here" file={files.reactProfile} onFile={(file) => updateFile("reactProfile", file)} />
                )}
              </div>

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
              <p>{profileType === "javascript"
                ? "Your profile stays on this device and is analyzed locally."
                : "React component profile analysis is coming soon — pick the JavaScript CPU profile to analyze now."}</p>
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

        {phase === "results" && (
          <>
            <div className="results-header">
              <div className="intro">
                <span className="eyebrow">Analysis results</span>
                <h1 className="results-title">Bottlenecks, slowest first</h1>
                <p>
                  {hotspots.length} bottleneck{hotspots.length === 1 ? "" : "s"} found · total profile time {formatMs(totalMs)}
                </p>
                {analyzerUsage && (
                  <p className="usage-line" title="Tokens consumed by the analyzer agent for this analysis">
                    analyzer · {formatTokens(analyzerUsage.totalTokens)} tokens · {usageBreakdown(analyzerUsage)}
                  </p>
                )}
              </div>
              <Button tone="primary" variant="outline" onClick={resetToUpload}>New analysis</Button>
            </div>

            <p className="grouping-note">Related calls share one card. Combined time adds their self times, counting each sample once.</p>
            <div className="hotspot-list">
              {hotspots.map((hotspot, index) => (
                <button
                  key={hotspot.id}
                  type="button"
                  className={`hotspot-card${selectedId === hotspot.id ? " selected" : ""}`}
                  aria-pressed={selectedId === hotspot.id}
                  onClick={() => selectHotspot(hotspot.id)}
                >
                  <span className="hotspot-rank">{index + 1}</span>
                  <span className="hotspot-main">
                    <span className="hotspot-top">
                      <strong>{hotspot.title}</strong>
                      <span className="hotspot-time">{formatMs(hotspot.combinedTimeMs)} · {hotspot.percentOfTotal}%</span>
                    </span>
                    <span className="hotspot-bar" aria-hidden="true">
                      <span style={{ width: `${maxPercent > 0 ? Math.max(4, (hotspot.percentOfTotal / maxPercent) * 100) : 0}%` }} />
                    </span>
                    <small>{hotspot.summary}</small>
                    <span className="function-breakdown">
                      <span className="function-heading">{hotspot.functions.length} function{hotspot.functions.length === 1 ? "" : "s"} · self time within this bottleneck</span>
                      {hotspot.functions.map((fn) => (
                        <span className="function-row" key={fn.id}>
                          <span className="function-name" title={fn.stack.join("\n")}>{fn.title}</span>
                          <span>{formatMs(fn.selfTimeMs)} · {fn.percentOfGroup}%</span>
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            {selected && (
              <section className="details-panel" aria-live="polite">
                <div className="details-heading">
                  <div>
                    <span className="eyebrow">Bottleneck details</span>
                    <h2>{selected.title}</h2>
                  </div>
                  <div className="details-metrics">
                    <div>
                      <small>Combined time</small>
                      <strong>{formatMs(selected.combinedTimeMs)}</strong>
                    </div>
                    <div>
                      <small>Share of total</small>
                      <strong>{selected.percentOfTotal}%</strong>
                    </div>
                  </div>
                </div>

                <p className="details-summary">{selected.summary}</p>

                <div className="details-block">
                  <h3>Functions in this bottleneck</h3>
                  {selected.functions.map((fn) => (
                    <details className="function-detail" key={fn.id}>
                      <summary>{fn.title} · {formatMs(fn.selfTimeMs)} self time · {fn.percentOfGroup}% of bottleneck</summary>
                      <p>Representative stack; self time may include other call paths.</p>
                      <ol className="stack-view">
                        {fn.stack.map((frame, index) => <li key={index}>{frame}</li>)}
                      </ol>
                    </details>
                  ))}
                </div>

                <div className="details-block">
                  <h3>Possible solution</h3>
                  <p>{selected.suggestedFix}</p>
                </div>

                <div className="details-block prompt-block">
                  <div className="prompt-head">
                    <h3>Debugging prompt</h3>
                    <span className="prompt-head-actions">
                      {selectedPromptUsage && (
                        <span className="usage-chip" title="Tokens consumed by the agent that generated this prompt">
                          {formatTokens(selectedPromptUsage.totalTokens)} tokens · {usageBreakdown(selectedPromptUsage)}
                        </span>
                      )}
                      <Button
                        size="sm"
                        disabled={!prompts[selected.id]}
                        onClick={() => void copyPrompt()}
                      >
                        {copied ? "Copied!" : "Copy prompt"}
                      </Button>
                    </span>
                  </div>

                  {promptLoadingId === selected.id ? (
                    <p className="prompt-loading">
                      <span className="spinner" aria-hidden="true" />
                      Generating a prompt from the hotspot details…
                    </p>
                  ) : prompts[selected.id] ? (
                    <details className="prompt-details" open={false}>
                      <summary>View generated prompt</summary>
                      <pre className="prompt-box">{prompts[selected.id]}</pre>
                    </details>
                  ) : promptErrors[selected.id] ? (
                    <p className="prompt-error">
                      {promptErrors[selected.id]}
                      <Button size="sm" tone="danger" variant="outline" onClick={() => void generatePrompt(selected.id)}>Retry</Button>
                    </p>
                  ) : (
                    <div className="prompt-generate">
                      <p className="prompt-loading">No prompt generated for this hotspot yet.</p>
                      <Button
                        disabled={promptLoadingId !== null}
                        onClick={() => void generatePrompt(selected.id)}
                      >
                        Generate prompt
                      </Button>
                    </div>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </section>
      </PluginShell.Body>
    </PluginShell>
  );
}
