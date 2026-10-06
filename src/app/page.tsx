"use client";

import Image from "next/image";
import { ChangeEvent, DragEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
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
import { ThemeGate } from "@/app/theme-gate";
import { TaskContribution } from "@/app/task-contribution";
import { ReactContribution, reactCulpritShape } from "@/app/react-contribution";
import { type ContributionChartKind } from "@/app/contribution-chart";
import type { Hotspot } from "@/lib/analysis";
import type { ProfileCard } from "@/lib/profile-cards";
import { reactExploreHref, storeCardForExplore, taskExploreHref } from "@/lib/card-handoff";
import { type TaskCard, type TaskCardSet } from "@/lib/task-cards";
import { CHART_SLICES } from "@/lib/contribution";
import { formatMs } from "@/lib/format";
import { profileCardLocations, taskCardLocations } from "@/lib/frame-location";
import { shortLocationLabel } from "@/lib/source-location";
import { MIN_HOTSPOT_TIME_MS } from "@/lib/bottlenecks";
import { pollOAuthAttempt, type OAuthAttempt } from "@/lib/oauth-client";
import type { ReactIssue } from "@/lib/react-analyzer";
import type { ReactCard, ReactCardSet } from "@/lib/react-cards";
import { reactCommitSlices } from "@/lib/react-contribution";

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
  taskCards?: TaskCardSet;
  cards?: ProfileCard[];
  callCountIsExact?: boolean;
  usage?: TokenUsage;
  model?: AnalysisModel;
}
interface HistoryItem { id: string; createdAt: number; profileType: "cpu" | "react"; title: string; totalTokens: number; issueCount: number; }
interface SavedAnalysis { id: string; createdAt: number; profileType: "cpu" | "react"; title: string; saved: boolean; totalMs: number; hotspots: Hotspot[]; taskCards?: TaskCardSet; cards?: ProfileCard[]; callCountIsExact?: boolean; reactCards?: ReactCardSet; reactIssues: ReactIssue[]; prompts: Record<string, string>; usage: TokenUsage; model?: AnalysisModel; }
interface AuthMethod { type: 'api_key' | 'oauth'; label: string; configured: boolean; subscription: boolean; }
interface ModelProvider { id: string; name: string; authMethods: AuthMethod[]; models: Array<{ id: string; name: string }>; }
interface ModelSettings {
  configured: boolean;
  providerId?: string;
  modelId?: string;
  authMode?: 'api_key' | 'oauth';
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

interface AnalysisModel {
  provider: string;
  model: string;
  providerId?: string;
  modelId?: string;
}

const acceptedFiles: Record<UploadKind, string> = {
  cpu: ".json,application/json",
  reactProfile: ".json,application/json",
};

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

function ResultModel({ model, usage }: { model: AnalysisModel | null; usage: TokenUsage }) {
  const provider = model?.provider ?? (usage.totalTokens === 0 ? "Local analysis" : "Provider unavailable");
  const modelName = model?.model ?? (usage.totalTokens === 0 ? "No model used" : "Model unavailable");

  return (
    <div className="result-model" title="Provider and model used for this analysis">
      <span>{provider}</span>
      <strong>{modelName}</strong>
    </div>
  );
}

function errorMessageFrom(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

function HeaderIcon({ type }: { type: "history" | "settings" | "help" | "close" | "arrow" | "back" | "explore" | "sparkle" | "chevron-up" | "chevron-down" }) {
  const paths = {
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.15.38.36.72.65 1 .3.27.68.41 1.08.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 1 1 4.15 1.88C12.7 11.7 12 12.15 12 13.5M12 17h.01" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    back: <path d="M19 12H5m6 6-6-6 6-6" />,
    explore: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
    sparkle: <><path d="M12 3.5 13.7 8.3 18.5 10 13.7 11.7 12 16.5 10.3 11.7 5.5 10 10.3 8.3Z" /><path d="M18 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" /></>,
    "chevron-up": <path d="m6 14 6-6 6 6" />,
    "chevron-down": <path d="m6 10 6 6 6-6" />,
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
    ? "analyzer · 2.3k tokens · 1.3k in · 975 out"
    : "analyzer · 2.6k tokens · 1.9k in · 752 out";
  const issueTitle = isCpu
    ? "toLocaleString date formatting dominates sorting inside getUserByUserName on _onFocus"
    : "Expensive render work in HeavyActivityHeatmap";
  const time = isCpu ? "2.05 s" : "125 ms";
  const share = isCpu ? "97% of group" : "74% of commit";
  const detail = isCpu
    ? "Native datePrototypeToLocaleStringHelper costs 2050 ms of self time, reached through arrayPrototypeSort inside getUserByUserName from the _onFocus dispatch."
    : "HeavyActivityHeatmap used 124.8 ms self time, 73.5% of a 169.7 ms over-budget React render.";

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
          <span className="snapshot-budget">{isCpu ? "2.11 s" : "high · commit 170 ms"}</span>
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
  loading,
  copied,
  busy,
  onCopy,
}: {
  loading: boolean;
  copied: boolean;
  busy: boolean;
  onCopy: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="prompt-action-button"
      disabled={loading || busy}
      onClick={onCopy}
    >
      {loading ? <RozeniteLoader size={14} label="" /> : copied ? <Check /> : <Copy />}
      {loading ? "Copying…" : copied ? "Copied!" : "Copy handoff"}
    </Button>
  );
}

const MAX_RESULT_CARDS = 3;

/**
 * Component rows a React card shows. Eight is what the cards' own culprit floor
 * admits on a realistic commit, and past it the footnote says as much as another
 * row would.
 */
const MAX_REACT_CARD_ROWS = 8;

/**
 * The smallest share of a commit worth its own row.
 *
 * The cards' own culprit floor (0.5 ms, or 1% of the commit) is set for the
 * hand-off, where an agent reading the repo can use a small component as a
 * hint. On the card it produced rows like `VirtualizedList 3 ms / 1% of
 * commit`: true, measured, and nothing a reader can act on, sitting at the
 * same visual weight as the 142 ms row above it. Five percent is the point
 * where fixing the component could plausibly move the commit.
 */
const REACT_ROW_MIN_SHARE = 5;

function reactIssueRemainingMs(issue: ReactIssue): number {
  return Math.max(0, issue.commit.durationMs - issue.components.reduce((total, component) => total + component.selfTimeMs, 0));
}

/** One "hot path" row: a single function's share of a card's total time. */
interface HotPathRow {
  /** Recorded `path:line:column`, shown only when the frame named a real source file. */
  location?: string;
  title?: string;
  ms?: number;
  percentLabel?: string;
  /** The second of a row's two figures, e.g. self time beside total time. */
  secondaryLabel?: string;
  barPercent?: number;
  caption?: string;
  /**
   * How this row's time was distributed over separate calls. The single most
   * actionable line on a task card: one 424 ms call is an algorithm to fix and
   * 54 calls of 8 ms is a call site to stop hitting, and a total alone renders
   * both identically.
   */
  shape?: string;
  /**
   * The named callers that reached this row's frame, outermost first. A
   * function name alone rarely says what to do about it; the frames that called
   * it place it in a feature and usually in a loop.
   */
  callers?: string;
  /** Opens Explore on this row's frame inside the task. */
  onFocus?: () => void;
}

interface HotPathCard {
  rows: HotPathRow[];
  footnotes: string[];
}

/**
 * A caller sampled in several bursts is one bottleneck, but its total and its
 * worst single burst answer different questions: how much work it costs overall,
 * and how much of that lands in one block a user could feel.
 */
function occurrenceLabel(hotspot: Hotspot): string | undefined {
  if (!hotspot.occurrences || hotspot.occurrences < 2) return undefined;
  return `${hotspot.occurrences} bursts · longest ${formatMs(hotspot.longestRunMs)}`;
}

function hotspotRows(hotspot: Hotspot): HotPathCard {
  // The name is measured; only the explanation comes from the agent. Keying the
  // explanation by function id keeps a row's caption about that row's function.
  const ranked = hotspot.functions
    .map((fn) => ({ fn, detail: hotspot.evidence?.[fn.id] }))
    .sort((a, b) => b.fn.selfTimeMs - a.fn.selfTimeMs);
  const shown = ranked.slice(0, MAX_RESULT_CARDS);
  const rows: HotPathRow[] = shown.map(({ fn, detail }) => ({
    location: fn.location,
    title: fn.title,
    ms: fn.selfTimeMs,
    percentLabel: `${Math.round(fn.percentOfGroup)}% of group`,
    barPercent: fn.percentOfGroup,
    caption: detail,
  }));

  // Only the top rows are published, so the group's own named total has to come
  // from the server; subtracting the shown rows alone reported measured functions
  // as unattributed time.
  const shownMs = shown.reduce((sum, { fn }) => sum + fn.selfTimeMs, 0);
  const namedMs = hotspot.namedTimeMs ?? ranked.reduce((sum, { fn }) => sum + fn.selfTimeMs, 0);
  const unlistedCount = (hotspot.namedFunctionCount ?? ranked.length) - shown.length;
  const unlistedMs = Math.max(0, namedMs - shownMs);
  const unnamedMs = Math.max(0, hotspot.combinedTimeMs - namedMs);

  const footnotes: string[] = [];
  if (unlistedCount > 0 && unlistedMs >= 1) {
    footnotes.push(`+ ~${formatMs(unlistedMs)} across ${unlistedCount} further measured function${unlistedCount === 1 ? "" : "s"}`);
  }
  // The naming threshold scales with the profile's sampling interval, so it has
  // to be read off the group rather than restated as the group-ranking constant.
  if (unnamedMs >= 1) {
    const cutoff = hotspot.minFunctionTimeMs ?? MIN_HOTSPOT_TIME_MS;
    footnotes.push(`+ ~${formatMs(unnamedMs)} spread thinly across functions under ${formatMs(cutoff)} each`);
  }

  return { rows, footnotes };
}

/**
 * A card's "Main highlights": the heaviest named work inside the parent's
 * subtree, each with both of its times. Inclusive time is what ranks them —
 * self time alone cannot say that a 240 ms helper sits under this parent.
 */
function cardRows(card: ProfileCard): HotPathCard {
  const locations = profileCardLocations(card);
  const rows: HotPathRow[] = card.highlights.map((highlight) => ({
    location: locations.shown(highlight.name, highlight.location),
    title: highlight.name,
    ms: highlight.totalMs,
    secondaryLabel: `${formatMs(highlight.selfMs)} self`,
    percentLabel: card.totalMs > 0 ? `${Math.round((highlight.totalMs / card.totalMs) * 100)}% of parent` : undefined,
    barPercent: card.totalMs > 0 ? (highlight.totalMs / card.totalMs) * 100 : 0,
  }));

  const footnotes: string[] = [];
  footnotes.push(
    card.selfShape === "longTail"
      ? `${formatMs(card.selfMs)} is spread across calls too small to list`
      : `${formatMs(card.selfMs)} in its own body`
  );
  if (card.subtreeFunctionCount > card.highlights.length) {
    footnotes.push(`${card.subtreeFunctionCount} functions ran under this parent in total`);
  }
  if (card.confidence === "low") {
    footnotes.push("few samples landed here — treat these figures as a hint");
  }
  return { rows, footnotes };
}

/**
 * A task card's content is a drawing of how the block divides between the
 * features it entered, plus the footnotes that qualify the measurement.
 *
 * It was a list of culprit rows until the chart replaced it, and before that a
 * list of boundary frames with inclusive-time bars. Both were readings of a
 * card as eight independent rows, which is the thing the chart is not: the rows
 * shared no whole, so a reader could not see that the eight heaviest culprits
 * of a 3227 ms task account for 30% of it, nor what the other 70% was.
 *
 * Dividing by boundary frame instead is what makes the whole say something. See
 * `contribution.ts` for why both levels of the chart are honest partitions, and
 * why the residuals are slices rather than footnotes — which is also why the
 * footnotes below no longer describe the remainder.
 */
function taskCardFootnotes(card: TaskCard): string[] {
  const footnotes: string[] = [];
  if (card.confidence === "low") footnotes.push("few samples landed in this task — treat these figures as a hint");
  return footnotes;
}

/**
 * A task that entered no frame of its own — a bundle whose identifiers are all
 * mangled, or work that really was all framework — has no features to divide
 * into, so the chart could only say "none of this was your code" and offer
 * nothing to open. Its culprits can still name functions, so the card falls
 * back to the rows they used to be drawn as.
 */
function taskFallbackRows(card: TaskCard, onFocus: (nodeId: string) => void): HotPathRow[] {
  const locations = taskCardLocations(card);
  return card.culprits.slice(0, CHART_SLICES).map((culprit) => ({
    location: locations.shown(culprit.name, culprit.location),
    title: culprit.name,
    ms: culprit.selfMs,
    // Only when the two differ. A leaf burns all of its own time, so printing
    // `1.57 s` beside `1.57 s with callees` says the same thing twice.
    secondaryLabel: culprit.totalMs - culprit.selfMs >= 1 ? `${formatMs(culprit.totalMs)} with callees` : undefined,
    percentLabel: card.durationMs > 0 ? `${Math.round((culprit.selfMs / card.durationMs) * 100)}% of task` : undefined,
    barPercent: card.durationMs > 0 ? (culprit.selfMs / card.durationMs) * 100 : 0,
    shape: culprit.shapeText,
    callers: culprit.callers.length > 0 ? culprit.callers.join(" › ") : undefined,
    onFocus: () => onFocus(culprit.nodeId),
  }));
}

/* A task card's heading used to carry a third line naming the rest of the
   boundary frames ("also keysChanged 306 ms · …"). The breakdown beneath the
   chart already names every one of them with its share, so the line repeated
   the evidence in a form you could not click. The heading now stops at the
   shape. */

/**
 * Which drawing the cards below are read as. One control for both families: a
 * reader who prefers one reading of a part-of-whole prefers it on a commit for
 * the same reason they prefer it on a task.
 */
function ChartSwitch({
  kind,
  onChange,
}: {
  kind: ContributionChartKind;
  onChange: (kind: ContributionChartKind) => void;
}) {
  return (
    <div className="chart-switch">
      <span className="chart-switch-label">contribution</span>
      {(["bar", "treemap"] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={kind === option ? "timeline-zoom is-current" : "timeline-zoom"}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/** The second line of a card: how often this frame ran. */
function cardSubtitle(card: ProfileCard, callCountIsExact: boolean): string | undefined {
  const count = callCountIsExact ? card.invocations ?? card.callSites : card.callSites;
  if (count <= 1) return undefined;
  return callCountIsExact ? `called ${count} times` : `${count} call sites`;
}

/**
 * A React card's rows: the components that burned the commit's own time.
 *
 * The fallback the chart leaves behind. A commit whose components are all under
 * the culprit floor — three hundred fibers at 0.1 ms each on a 20 ms commit —
 * divides into nothing but residuals, so the chart could only say that none of
 * it was any one component's fault. Its heaviest component is still a name, and
 * these rows are where it is printed.
 *
 * `percentOfCommit` rather than a share of the summed self time, because the
 * commit's duration is the figure the heading claims and the one a reader can
 * check against the recording.
 */
function reactCardRows(card: ReactCard): HotPathCard {
  // The top culprit is always shown, however small: a card exists because its
  // commit went over budget, and a card with no rows states the problem while
  // withholding the only name it has for it.
  const worthARow = card.culprits.filter((culprit) => culprit.percentOfCommit >= REACT_ROW_MIN_SHARE);
  const shown = (worthARow.length > 0 ? worthARow : card.culprits.slice(0, 1)).slice(0, MAX_REACT_CARD_ROWS);
  const rows: HotPathRow[] = shown.map((culprit) => ({
    location: culprit.sourceHint ?? undefined,
    title: culprit.component,
    ms: culprit.selfMs,
    percentLabel: `${Math.round(culprit.percentOfCommit)}% of commit`,
    barPercent: culprit.percentOfCommit,
    shape: reactCulpritShape(culprit),
    callers: culprit.path.length > 1 ? culprit.path.slice(0, -1).join(" › ") : undefined,
  }));
  /* No footnotes. The three this card used to carry — the sub-floor tail, the
     reconciler residual, and the effect durations — were each a sentence of
     arithmetic about time no component is responsible for, which is time the
     reader cannot act on. They are still in the record, and still in the
     hand-off, where an agent that can read the repo can use them. */
  return { rows, footnotes: [] };
}

function reactIssueRows(issue: ReactIssue): HotPathCard {
  const remainingMs = reactIssueRemainingMs(issue);
  return {
    rows: issue.components.map(component => ({
      title: component.component,
      ms: component.selfTimeMs,
      percentLabel: `${Math.round(component.percentOfCommit)}% of commit`,
      barPercent: component.percentOfCommit,
      caption: component.evidence.trim() || undefined,
    })),
    footnotes: remainingMs >= 1
      ? [`+ ~${formatMs(remainingMs)} other commit work not represented by these findings`]
      : [],
  };
}

function AnalysisResultCard({
  rank,
  title,
  shape,
  subtitle,
  timeLabel,
  insight,
  onExplain,
  explaining,
  insightError,
  chart,
  rows,
  footnotes,
  loading,
  error,
  copied,
  busy,
  onCopy,
  onExplore,
}: {
  rank: number;
  title: string;
  /**
   * The second heading row: the measured shape of the cost, where the card has
   * one. Under evaluation beside `title`, so it is optional and the legacy
   * engines below simply do not pass it.
   */
  shape?: string;
  subtitle?: string;
  timeLabel: string;
  /**
   * The model's reading of this finding, when AI assist is on. Labelled on the
   * card because it is the only thing there that was not measured, and placed
   * below the rows: the reading is the conclusion the evidence above leads to,
   * and it lands next to the button that asked for it.
   */
  insight?: string[];
  /** Asks a model to read this task. Absent where no inference is on offer. */
  onExplain?: () => void;
  explaining?: boolean;
  insightError?: string;
  /**
   * The evidence as a drawing rather than as rows. Where a finding divides into
   * parts of a whole it is the better reading, and where it does not — a React
   * commit, a hotspot group — the card still takes rows.
   */
  chart?: ReactNode;
  rows: HotPathRow[];
  footnotes: string[];
  loading: boolean;
  error?: string;
  copied: boolean;
  busy: boolean;
  onCopy: () => void;
  onExplore?: () => void;
}) {
  /* The reading opens with the card that produced it; hiding it is for getting
     back to the measured evidence without losing the reading. */
  const [readingOpen, setReadingOpen] = useState(true);
  const hasReading = Boolean(insight && insight.length > 0);
  return (
    <article className="hotspot-card">
      <div className="hotspot-head">
        <span className="hotspot-rank">#{rank}</span>
        <div className="hotspot-heading-copy">
          <strong>{title}</strong>
          {shape ? <span className="hotspot-shape">{shape}</span> : null}
          {subtitle ? <span className="hotspot-subtitle">{subtitle}</span> : null}
        </div>
        <span className="hotspot-time">{timeLabel}</span>
      </div>
      {chart}
      {/* The footnotes qualify whatever evidence the card carried, so they
          belong to the chart as much as to the rows. */}
      {chart && rows.length === 0 && footnotes.length > 0 ? (
        <div className="hot-path-rows hot-path-rows-footnotes-only">
          {footnotes.map((footnote) => <p className="hot-path-footnote" key={footnote}>{footnote}</p>)}
        </div>
      ) : null}
      {rows.length > 0 && (
        <div className="hot-path-rows">
          {rows.map((row, rowIndex) => (
            <div className="hot-path-row" key={rowIndex}>
              {row.location ? (
                <p className="row-location" title={row.location}>
                  <span className="row-location-label">file</span>
                  <code>{shortLocationLabel(row.location)}</code>
                </p>
              ) : null}
              {row.title ? (
                row.onFocus
                  ? <button type="button" className="row-title row-title-link" onClick={row.onFocus}>{row.title}</button>
                  : <strong className="row-title">{row.title}</strong>
              ) : null}
              {row.callers ? (
                <p className="row-callers" title={row.callers}>
                  <span className="row-callers-label">via</span>
                  {row.callers}
                </p>
              ) : null}
              {row.ms !== undefined && (
                <>
                  <div className="row-figure-line">
                    <span className="row-figure">{formatMs(row.ms)}</span>
                    {row.secondaryLabel ? <span className="row-secondary">{row.secondaryLabel}</span> : null}
                    {row.percentLabel ? <span className="row-share">{row.percentLabel}</span> : null}
                  </div>
                  <div className="row-bar-track" aria-hidden="true">
                    <span className="row-bar-fill" style={{ width: `${row.barPercent ?? 0}%` }} />
                  </div>
                </>
              )}
              {row.shape ? <p className="row-shape">{row.shape}</p> : null}
              {row.caption ? <p className="row-caption">{row.caption}</p> : null}
            </div>
          ))}
          {footnotes.map((footnote) => <p className="hot-path-footnote" key={footnote}>{footnote}</p>)}
        </div>
      )}
      {insight && insight.length > 0 && readingOpen ? (
        <div className="card-insight">
          <span className="card-insight-label">AI reading</span>
          <ul>{insight.map((finding) => <li key={finding}>{finding}</li>)}</ul>
        </div>
      ) : null}
      {insightError ? <p className="hotspot-prompt-error card-insight-error">{insightError}</p> : null}
      <div className="hotspot-footer">
        {error ? <p className="hotspot-prompt-error">{error}</p> : null}
        <div className="hotspot-footer-bar">
          <div className="hotspot-footer-lead">
            {hasReading ? (
              <Button
                size="sm"
                variant="outline"
                className="prompt-action-button explain-action-button"
                aria-expanded={readingOpen}
                onClick={() => setReadingOpen((open) => !open)}
              >
                <HeaderIcon type={readingOpen ? "chevron-down" : "chevron-up"} />
                {readingOpen ? "Hide AI reading" : "Show AI reading"}
              </Button>
            ) : onExplain ? (
              <Button
                size="sm"
                variant="outline"
                className="prompt-action-button explain-action-button"
                disabled={explaining}
                onClick={onExplain}
                title="Have a model read this task's timeline and name the issue and where it starts."
              >
                {explaining ? <RozeniteLoader size={14} label="" /> : <HeaderIcon type="sparkle" />}
                {explaining ? "Reading…" : "Explain with AI"}
              </Button>
            ) : null}
          </div>
          <div className="hotspot-actions">
            {onExplore ? (
              <Button size="sm" variant="outline" className="prompt-action-button" onClick={onExplore}>
                <HeaderIcon type="explore" /> Explore
              </Button>
            ) : null}
            <PromptActionButton
              loading={loading}
              copied={copied}
              busy={busy}
              onCopy={onCopy}
            />
          </div>
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

  const acceptFile = (candidate?: File) => (candidate && !candidate.name.toLowerCase().endsWith(".json") ? undefined : candidate);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    onFile(acceptFile(event.target.files?.[0]));
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    onFile(acceptFile(event.dataTransfer.files?.[0]));
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

export default function Home() {
  return <ThemeGate><InspectorApp /></ThemeGate>;
}

function InspectorApp() {
  const [guideOpen, setGuideOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [autoSave, setAutoSave] = useState(true);
  const [aiAssisted, setAiAssisted] = useState(true);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [profileType, setProfileType] = useState<ProfileType>("javascript");
  const [showWelcome, setShowWelcome] = useState(true);
  const [files, setFiles] = useState<Partial<Record<UploadKind, File>>>({});
  const [modelStatus, setModelStatus] = useState<ModelSettings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedAuthMode, setSelectedAuthMode] = useState<'api_key' | 'oauth'>('api_key');
  const [apiKey, setApiKey] = useState("");
  const [oauthAttempt, setOauthAttempt] = useState<OAuthAttempt | null>(null);
  const oauthPopup = useRef<Window | null>(null);
  const oauthPopupNavigated = useRef(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSettingsMessage, setModelSettingsMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  useEffect(() => {
    try { localStorage.removeItem("tracesift.apex-api-key"); } catch { /* Storage may be disabled. */ }
    const controller = new AbortController();
    fetch("/api/model", { signal: controller.signal, cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((settings: ModelSettings) => {
        setModelStatus(settings);
        setSelectedProvider(settings.providerId ?? "");
        setSelectedModel(settings.modelId ?? "");
        setSelectedAuthMode(settings.authMode ?? 'api_key');
      })
      .catch(() => { if (!controller.signal.aborted) setModelStatus({ configured: false, providers: [], error: "Could not load model configuration. Reload the page." }); });
    return () => controller.abort();
  }, []);
  const refreshHistory = async () => {
    try { const response = await fetch("/api/analyses", { cache: "no-store" }); const data = await response.json(); setHistory(data.analyses ?? []); } catch { /* History is optional local state. */ }
  };
  useEffect(() => {
    void refreshHistory();
    fetch("/api/analysis-settings", { cache: "no-store" }).then(r => r.json()).then(data => {
      setAutoSave(data.autoSave !== false);
      setAiAssisted(data.aiAssisted !== false);
    }).catch(() => undefined);
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
  const [taskCards, setTaskCards] = useState<TaskCardSet | null>(null);
  const [cards, setCards] = useState<ProfileCard[]>([]);
  const [callCountIsExact, setCallCountIsExact] = useState(false);
  const [frameBudget, setFrameBudget] = useState("16");
  const [appliedBudget, setAppliedBudget] = useState(16);
  const [reactCards, setReactCards] = useState<ReactCardSet | null>(null);
  const [reactIssues, setReactIssues] = useState<ReactIssue[]>([]);
  const [reactSummary, setReactSummary] = useState<ReactSummary | null>(null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [analyzerUsage, setAnalyzerUsage] = useState<TokenUsage | null>(null);
  const [analysisModel, setAnalysisModel] = useState<AnalysisModel | null>(null);
  const [promptLoadingId, setPromptLoadingId] = useState<string | null>(null);
  const [promptErrors, setPromptErrors] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [explainingId, setExplainingId] = useState<string | null>(null);
  const [insightErrors, setInsightErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [isSample, setIsSample] = useState(false);
  // Two readings of the same slices are on offer while we decide which one a
  // card keeps; the switch is per page rather than per card so the comparison
  // is between pages of cards rather than between neighbours.
  const [chartKind, setChartKind] = useState<ContributionChartKind>("bar");

  const updateFile = (kind: UploadKind, file?: File) => {
    setFiles((current) => ({ ...current, [kind]: file }));
  };

  const validBudget = frameBudget.trim() !== "" && Number.isFinite(Number(frameBudget)) && Number(frameBudget) > 0;
  const isReady = Boolean(
    (profileType === "javascript" ? files.cpu : files.reactProfile)
    && (!aiAssisted || modelStatus?.configured)
    && (profileType !== "react" || validBudget),
  );

  const handleAnalyze = async () => {
    const file = profileType === "javascript" ? files.cpu : files.reactProfile;
    if (!file) {
      setError(profileType === "javascript" ? "Add a CPU profile file first." : "Add a React profile file first.");
      setErrorDetail(null);
      return;
    }
    if (aiAssisted && !modelStatus?.configured) {
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
        taskCards?: TaskCardSet;
        cards?: ProfileCard[];
        callCountIsExact?: boolean;
        usage?: TokenUsage;
        model?: AnalysisModel;
        summary?: ReactSummary;
        reactCards?: ReactCardSet;
        issues?: ReactIssue[];
        noIssue?: boolean;
        frameBudgetMs?: number;
      };
      if (!response.ok) {
        setError(data.error ?? `Analysis failed (${response.status}).`);
        setErrorDetail(data.detail ?? null);
        setPhase("upload");
        return;
      }

      setPrompts({});
      setAnalyzerUsage(data.usage ?? null);
      setAnalysisModel(data.model ?? null);
      setPromptErrors({});
      setCopiedId(null);
    setAnalyzedType(profileType);
    setSaved(data.saved === true);
    setIsSample(false);

      if (profileType === "react") {
        // The measured engine returns cards; the analyzer engine returns the
        // issue list it always did. Either is valid, neither is optional.
        if (!data.reactCards && (!Array.isArray(data.issues) || data.noIssue !== (data.issues.length === 0))) {
          setError("The server did not return a valid React report. Check the dev server logs.");
          setPhase("upload");
          return;
        }
        if ((data.reactCards?.cards.length || data.issues?.length) && !data.analysisId) {
          setError("The server did not return an analysis id. Check the dev server logs.");
          setPhase("upload");
          return;
        }
        setAnalysisId(data.analysisId ?? null);
        setHotspots([]);
        setTaskCards(null);
        setCards([]);
        setReactCards(data.reactCards ?? null);
        setReactIssues(data.issues ?? []);
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
        taskCards: data.taskCards,
        cards: data.cards ?? [],
        callCountIsExact: data.callCountIsExact === true,
        usage: data.usage,
        model: data.model,
      };
      if (!result.analysisId) {
        setError("The server did not return an analysis id. Check the dev server logs.");
        setPhase("upload");
        return;
      }
      setAnalysisId(result.analysisId);
      setTotalMs(result.totalMs);
      setHotspots(result.hotspots);
      setTaskCards(result.taskCards ?? null);
      setCards(result.cards ?? []);
      setCallCountIsExact(result.callCountIsExact === true);
      setReactSummary(null);
      setReactCards(null);
      setPhase("results");
      void refreshHistory();
    } catch (err) {
      setError(errorMessageFrom(err));
      setErrorDetail(null);
      setPhase("upload");
    }
  };

  const copyText = async (text: string) => {
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
  };

  const markHandoffCopied = (id: string) => {
    setCopiedId(id);
    setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 2000);
  };

  /**
   * Open one card's subtree in its own tab. The card already carries everything
   * the view needs, so this is a storage write and a `window.open` — no new
   * endpoint, and nothing extra kept on the server.
   */
  const exploreCard = (card: ProfileCard) => {
    if (!analysisId) return;
    const href = storeCardForExplore({
      analysisId,
      totalMs,
      callCountIsExact,
      card,
    });
    window.open(href, "_blank", "noopener");
  };

  /**
   * Open one task in its own tab. With a frame id the view opens focused on
   * that frame; without one it opens on the whole task, which is what a click
   * on the card header means.
   */
  const exploreTask = (card: TaskCard, focusNodeId?: string) => {
    if (!analysisId) return;
    window.open(taskExploreHref(analysisId, card.taskIndex, focusNodeId), "_blank", "noopener");
  };

  /**
   * Open one React commit in its own tab.
   *
   * The recording is fetched there rather than handed over, like a task: the
   * commit trees live on the analysis record and the drill-down opens on the
   * whole strip, not on this commit alone.
   */
  const exploreReactCommit = (card: ReactCard) => {
    if (!analysisId) return;
    window.open(reactExploreHref(analysisId, card.rootId, card.commitIndex), "_blank", "noopener");
  };

  /**
   * Ask a model to read one React commit.
   *
   * The same button, the same storage and the same discard of a stale hand-off
   * as `explainTask` below. What the model is shown differs — a commit has no
   * timeline and no call tree, only the components and the recorded reasons —
   * and `react-insight.ts` is where that is said.
   */
  const explainReactCard = async (card: ReactCard) => {
    if (!analysisId || explainingId) return;
    setExplainingId(card.id);
    setInsightErrors((current) => {
      if (!(card.id in current)) return current;
      const next = { ...current };
      delete next[card.id];
      return next;
    });
    try {
      const response = await fetch("/api/react-insight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId, cardId: card.id }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; insight?: ReactCard["insight"]; usage?: TokenUsage; model?: AnalysisModel };
      if (!response.ok || !data.insight) throw new Error(data.error ?? `Could not read this commit (${response.status}).`);
      const insight = data.insight;
      setReactCards((current) => current && ({
        ...current,
        cards: current.cards.map((entry) => (entry.id === card.id ? { ...entry, insight } : entry)),
      }));
      setPrompts((current) => {
        if (!(card.id in current)) return current;
        const next = { ...current };
        delete next[card.id];
        return next;
      });
      if (data.usage) setAnalyzerUsage(data.usage);
      if (data.model) setAnalysisModel(data.model);
    } catch (err) {
      setInsightErrors((current) => ({ ...current, [card.id]: errorMessageFrom(err) }));
    } finally {
      setExplainingId((current) => (current === card.id ? null : current));
    }
  };

  /**
   * Ask a model to read one task. The server stores what comes back on the
   * analysis, so the card is updated in place rather than re-fetched, and a
   * hand-off already copied for this task is dropped — the next one carries
   * the inference the server has just cached against it.
   */
  const explainTask = async (card: TaskCard) => {
    if (!analysisId || explainingId) return;
    setExplainingId(card.id);
    setInsightErrors((current) => {
      if (!(card.id in current)) return current;
      const next = { ...current };
      delete next[card.id];
      return next;
    });
    try {
      const response = await fetch("/api/task-insight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId, cardId: card.id }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; insight?: TaskCard["insight"]; usage?: TokenUsage; model?: AnalysisModel };
      if (!response.ok || !data.insight) throw new Error(data.error ?? `Could not read this task (${response.status}).`);
      const insight = data.insight;
      setTaskCards((current) => current && ({
        ...current,
        cards: current.cards.map((entry) => (entry.id === card.id ? { ...entry, insight } : entry)),
      }));
      setPrompts((current) => {
        if (!(card.id in current)) return current;
        const next = { ...current };
        delete next[card.id];
        return next;
      });
      if (data.usage) setAnalyzerUsage(data.usage);
      if (data.model) setAnalysisModel(data.model);
    } catch (err) {
      setInsightErrors((current) => ({ ...current, [card.id]: errorMessageFrom(err) }));
    } finally {
      setExplainingId((current) => (current === card.id ? null : current));
    }
  };

  const copyHandoff = async (id: string) => {
    if (!analysisId || promptLoadingId) return;
    setPromptErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setCopiedId(null);
    const existing = prompts[id];
    if (existing) {
      await copyText(existing);
      markHandoffCopied(id);
      return;
    }

    setPromptLoadingId(id);
    try {
      const isReact = analyzedType === "react";
      const response = await fetch(isReact ? "/api/react-issue-prompt" : "/api/hotspot-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isReact ? { analysisId, issueId: id } : { analysisId, hotspotId: id }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; prompt?: string };
      if (!response.ok || !data.prompt) {
        throw new Error(data.error ?? `Handoff creation failed (${response.status}).`);
      }
      setPrompts((current) => ({ ...current, [id]: data.prompt as string }));
      await copyText(data.prompt);
      markHandoffCopied(id);
    } catch (err) {
      setPromptErrors((current) => ({ ...current, [id]: errorMessageFrom(err) }));
    } finally {
      setPromptLoadingId((current) => (current === id ? null : current));
    }
  };

  const resetToUpload = () => {
    setPhase("upload");
    setError(null);
    setErrorDetail(null);
    setAnalysisId(null);
    setAnalyzedType("javascript");
    setHotspots([]);
    setTaskCards(null);
    setCards([]);
    setCallCountIsExact(false);
    setReactSummary(null);
    setReactCards(null);
    setReactIssues([]);
    setPrompts({});
    setAnalyzerUsage(null);
    setAnalysisModel(null);
    setPromptLoadingId(null);
    setPromptErrors({});
    setCopiedId(null);
    setExplainingId(null);
    setInsightErrors({});
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
    setTotalMs(analysis.totalMs); setHotspots(analysis.hotspots ?? []); setTaskCards(analysis.taskCards ?? null); setCards(analysis.cards ?? []);
    setCallCountIsExact(analysis.callCountIsExact === true); setReactCards(analysis.reactCards ?? null); setReactIssues(analysis.reactIssues ?? []);
    setPrompts(analysis.prompts ?? {}); setAnalyzerUsage(analysis.usage ?? null); setAnalysisModel(analysis.model ?? null);
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
  const updateAiAssisted = async (enabled: boolean) => {
    setAiAssisted(enabled);
    await fetch("/api/analysis-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aiAssisted: enabled }) });
  };
  const providerModels = modelStatus?.providers.find(provider => provider.id === selectedProvider)?.models ?? [];
  const selectedProviderSettings = modelStatus?.providers.find(provider => provider.id === selectedProvider);
  const selectedAuthMethod = selectedProviderSettings?.authMethods.find(method => method.type === selectedAuthMode);
  const activeAttemptId = oauthAttempt?.status === 'pending' ? oauthAttempt.attemptId : undefined;
  useEffect(() => {
    if (!activeAttemptId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const { attempt: next, settings } = await pollOAuthAttempt<ModelSettings>(activeAttemptId);
        if (cancelled) return;
        if (next.event?.type === 'auth_url' && next.event.url && oauthPopup.current && !oauthPopupNavigated.current) { oauthPopupNavigated.current = true; oauthPopup.current.location.href = next.event.url; }
        if (next.status === 'complete' && settings) {
          setModelStatus(settings);
          setModelSettingsMessage({ tone: 'success', text: 'Subscription connected. Choose a model and save it to use this connection.' });
        }
        if (next.status !== 'pending') oauthPopup.current?.close();
        // Keep the attempt pending until refreshed settings are ready. Changing it
        // earlier tears down this effect and discards the settings response.
        setOauthAttempt(next);
      } catch { if (!cancelled) setModelSettingsMessage({ tone: 'error', text: 'Could not check sign-in status.' }); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeAttemptId]);
  const oauthAction = async (body: Record<string, string>) => {
    const response = await fetch('/api/model/oauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not complete sign-in action.');
    return data;
  };
  const startOAuthLogin = async () => {
    if (!selectedProvider || oauthAttempt?.status === 'pending') return;
    setModelSettingsMessage(null);
    oauthPopupNavigated.current = false;
    oauthPopup.current = window.open('about:blank', '_blank');
    try {
      const attempt = await oauthAction({ action: 'start', provider: selectedProvider, method: 'browser' }) as OAuthAttempt;
      if (attempt.status !== 'pending') oauthPopup.current?.close();
      setOauthAttempt(attempt);
    }
    catch (error) { oauthPopup.current?.close(); setModelSettingsMessage({ tone: 'error', text: errorMessageFrom(error) }); }
  };
  const stopOAuthLogin = async () => {
    if (!oauthAttempt) return;
    try { setOauthAttempt(await oauthAction({ action: 'cancel', attemptId: oauthAttempt.attemptId }) as OAuthAttempt); oauthPopup.current?.close(); }
    catch (error) { setModelSettingsMessage({ tone: 'error', text: errorMessageFrom(error) }); }
  };
  const disconnectOAuth = async () => {
    try { const settings = await oauthAction({ action: 'logout', provider: selectedProvider }) as ModelSettings; setModelStatus(settings); setOauthAttempt(null); setModelSettingsMessage({ tone: 'success', text: 'Subscription disconnected from this device.' }); }
    catch (error) { setModelSettingsMessage({ tone: 'error', text: errorMessageFrom(error) }); }
  };
  const updateProvider = (provider: string) => {
    setSelectedProvider(provider);
    setSelectedModel(provider === modelStatus?.providerId ? modelStatus.modelId ?? "" : "");
    setSelectedAuthMode(provider === modelStatus?.providerId ? modelStatus.authMode ?? 'api_key' : provider === 'openai-codex' ? 'oauth' : 'api_key');
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
        body: JSON.stringify({ provider: selectedProvider, model: selectedModel, authMode: selectedAuthMode, ...(apiKey.trim() ? { apiKey } : {}) }),
      });
      const data = await response.json() as ModelSettings & { error?: string };
      if (!response.ok) throw new Error(data.error || `Could not save model settings (${response.status}).`);
      setModelStatus(data);
      setSelectedProvider(data.providerId ?? selectedProvider);
      setSelectedModel(data.modelId ?? selectedModel);
      setApiKey("");
      setModelSettingsMessage({ tone: "success", text: "Model settings saved on this device." });
    } catch (err) {
      setModelSettingsMessage({ tone: "error", text: errorMessageFrom(err) });
    } finally {
      setModelSaving(false);
    }
  };
  const clearModelSettings = async () => {
    if (modelSaving || !window.confirm("Clear the selected model, all saved API keys, and TraceSift subscription connections from this device?")) return;
    setModelSaving(true);
    setModelSettingsMessage(null);
    try {
      const response = await fetch("/api/model", { method: "DELETE", headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json() as ModelSettings & { error?: string };
      if (!response.ok) throw new Error(data.error || `Could not clear model settings (${response.status}).`);
      setModelStatus(data);
      setSelectedProvider("");
      setSelectedAuthMode('api_key');
      setSelectedModel("");
      setApiKey("");
      setModelSettingsMessage({ tone: "success", text: "Saved model settings and credentials cleared." });
    } catch (err) {
      setModelSettingsMessage({ tone: "error", text: errorMessageFrom(err) });
    } finally {
      setModelSaving(false);
    }
  };
  const loadCpuSample = async () => {
    const response = await fetch("/api/samples/cpu", { cache: "no-store" });
    if (!response.ok) return;
    const { analysis } = await response.json() as { analysis: SavedAnalysis };
    setAnalysisId(analysis.id); setAnalyzedType("javascript"); setTotalMs(analysis.totalMs);
    setHotspots(analysis.hotspots); setTaskCards(analysis.taskCards ?? null); setCards(analysis.cards ?? []);
    setCallCountIsExact(analysis.callCountIsExact === true); setReactCards(null); setReactIssues([]); setReactSummary(null);
    setPrompts({}); setAnalyzerUsage(analysis.usage); setAnalysisModel(analysis.model ?? null); setSaved(true); setIsSample(true); setPhase("results");
  };
  const loadReactSample = async () => {
    // Sample issue schemas can change between app releases. Bypass the browser's
    // HTTP cache so an older payload cannot be rendered by the current UI.
    const response = await fetch("/api/samples/react", { cache: "no-store" });
    if (!response.ok) return;
    const { analysis, summary } = await response.json() as { analysis: SavedAnalysis; summary: ReactSummary & { frameBudgetMs: number } };
    setAnalysisId(analysis.id); setAnalyzedType("react"); setTotalMs(analysis.totalMs);
    setHotspots([]); setTaskCards(null); setCards([]); setReactCards(analysis.reactCards ?? null); setReactIssues(analysis.reactIssues); setReactSummary(summary); setAppliedBudget(summary.frameBudgetMs);
    setPrompts({}); setAnalyzerUsage(analysis.usage); setAnalysisModel(analysis.model ?? null); setSaved(true); setIsSample(true); setPhase("results");
  };

  const analyzing = phase === "analyzing";

  return (
    <PluginShell>
      <PluginHeader>
        <PluginHeader.Title className="brand" render={<div />}>
          <Image src="/callstack-logo.png" alt="" width={30} height={30} priority />
          <span><span className="brand-name">TraceSift</span><small>by Callstack</small></span>
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
                <label className="autosave-toggle ai-assist-toggle">
                  <span className="toggle-copy"><strong>AI assisted</strong><small>Let a model name what each task got wrong and where it starts. Off, TraceSift reports only what it measured and never contacts a provider.</small></span>
                  <input type="checkbox" checked={aiAssisted} onChange={event => void updateAiAssisted(event.target.checked)} />
                  <span className="toggle-control" aria-hidden="true"><span /></span>
                </label>
                {aiAssisted ? (
                <div className="model-settings-form">
                  <label htmlFor="analysis-provider">Provider</label>
                  <select id="analysis-provider" value={selectedProvider} onChange={event => updateProvider(event.target.value)} disabled={!modelStatus || modelSaving}>
                    <option value="">Select a provider</option>
                    {modelStatus?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                  {selectedProvider && (
                    <>
                      <label htmlFor="analysis-auth">Authentication</label>
                      <select id="analysis-auth" value={selectedAuthMode} onChange={event => { setSelectedAuthMode(event.target.value as 'api_key' | 'oauth'); setApiKey(''); setModelSettingsMessage(null); }} disabled={modelSaving}>
                        {selectedProviderSettings?.authMethods.map(method => <option key={method.type} value={method.type}>{method.label}</option>)}
                      </select>
                      {selectedAuthMode === 'oauth' && (
                        <div className="oauth-panel">
                          <div className="oauth-intro">
                            <span className="oauth-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24" fill="none"><path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11M7 11h10v9H7z" /></svg>
                            </span>
                            <div>
                              <strong>Subscription sign-in</strong>
                              <p>Experimental PI OAuth. Access depends on your provider account and plan.</p>
                            </div>
                          </div>
                          {selectedAuthMethod?.configured ? (
                            <div className="oauth-connected">
                              <span className="oauth-status-dot" aria-hidden="true" />
                              <div><strong>Connected</strong><small>Authorized on this device</small></div>
                              <button type="button" onClick={() => void disconnectOAuth()}>Disconnect</button>
                            </div>
                          ) : oauthAttempt?.provider === selectedProvider && oauthAttempt.status === 'pending' ? (
                            <div className="oauth-pending" role="status">
                              <RozeniteLoader size={16} label="" />
                              <div>
                                <strong>Waiting for browser sign-in</strong>
                                {oauthAttempt.event?.type === 'auth_url' && oauthAttempt.event.url ? (
                                  <p>Finish signing in in the browser. <a href={oauthAttempt.event.url} target="_blank" rel="noopener noreferrer">Open sign-in page</a></p>
                                ) : (
                                  <p>Preparing the secure sign-in page…</p>
                                )}
                              </div>
                              <button className="oauth-cancel" type="button" onClick={() => void stopOAuthLogin()}>Cancel sign-in</button>
                            </div>
                          ) : (
                            <Button className="oauth-sign-in" type="button" size="sm" onClick={() => void startOAuthLogin()}>
                              Sign in with browser <HeaderIcon type="arrow" />
                            </Button>
                          )}
                          {oauthAttempt?.provider === selectedProvider && oauthAttempt.status !== 'pending' && oauthAttempt.status !== 'complete' && <p className="oauth-error" role="alert">{oauthAttempt.error}</p>}
                        </div>
                      )}
                      <label htmlFor="analysis-model">Model</label>
                      <select id="analysis-model" value={selectedModel} onChange={event => updateModel(event.target.value)} disabled={modelSaving}>
                        <option value="">Select a model</option>
                        {providerModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                      </select>
                    </>
                  )}
                  {selectedModel && (
                    <>
                      {selectedAuthMode === 'api_key' && <>
                      <label htmlFor="analysis-api-key">API key</label>
                      <input
                        id="analysis-api-key"
                        type="password"
                        value={apiKey}
                        autoComplete="new-password"
                        placeholder={selectedAuthMethod?.configured ? "Saved key (enter to replace)" : "Enter API key"}
                        onChange={event => { setApiKey(event.target.value); setModelSettingsMessage(null); }}
                        disabled={modelSaving}
                      />
                      <small className="model-key-help">
                        {selectedAuthMethod?.configured ? "A key is already saved for this provider." : "Required to use this provider."} The key stays in the local TraceSift configuration.
                      </small>
                      </>}
                      <Button
                        className="model-save-button"
                        type="button"
                        size="sm"
                        onClick={() => void saveModelSettings()}
                        disabled={modelSaving || (selectedAuthMode === 'api_key' ? !selectedAuthMethod?.configured && !apiKey.trim() : !selectedAuthMethod?.configured)}
                      >
                        {modelSaving ? "Saving…" : "Save model settings"}
                      </Button>
                    </>
                  )}
                  {modelSettingsMessage && <p className={`model-settings-message ${modelSettingsMessage.tone}`} role="status">{modelSettingsMessage.text}</p>}
                  {(modelStatus?.configured || modelStatus?.providers.some(provider => provider.authMethods.some(method => method.configured))) && (
                    <button className="clear-model-button" type="button" disabled={modelSaving} onClick={() => void clearModelSettings()}>
                      Clear model and all credentials
                    </button>
                  )}
                </div>
                ) : (
                  <p className="ai-assist-off-note">Saved credentials are kept but unused. Both profile types still produce full measured cards; what turns off is the per-card reading of them.</p>
                )}
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
                <span className="option-copy"><strong>JavaScript CPU</strong><small>Find slow functions and heavy execution paths</small><em>.json</em></span>
                <span className="radio-indicator" />
              </button>

              <button type="button" role="radio" aria-checked={profileType === "react"} disabled={analyzing} className={`profile-option${profileType === "react" ? " selected" : ""}`} onClick={() => setProfileType("react")}>
                <span className="profile-icon"><ProfileIcon type="react" /></span>
                <span className="option-copy"><strong>React components</strong><small>Find expensive commits, wasted re-renders and cascades</small><em>React DevTools JSON</em></span>
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
                  <UploadPane kind="cpu" title="JavaScript CPU profile" detail="Drop a Chrome Performance .json here" file={files.cpu} disabled={analyzing} onFile={(file) => updateFile("cpu", file)} />
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
                <Text>{!aiAssisted ? "AI assist is off — measured analysis only." : modelStatus === null ? "Loading model…" : modelStatus.configured
                  ? `Model: ${modelStatus.provider} / ${modelStatus.model}`
                  : modelStatus.error || "Choose a model in Analysis settings."}</Text>
                  <br />
                <Text className="italic text-muted-foreground">{aiAssisted ? "Change the provider or model from Analysis settings." : "Turn AI assist on in Analysis settings to have a model name each task's issue."}</Text>
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
              <p>{profileType === "react"
                ? "Your profile stays on this device. React commits are analyzed by measurement alone, so nothing leaves it unless you ask a card for an AI reading."
                : aiAssisted ? "Your profile stays on this device and is analyzed via your configured model." : "Your profile stays on this device, and with AI assist off nothing leaves it."}</p>
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

        {phase === "results" && analyzedType === "react" && (() => {
          const cardList = reactCards?.cards ?? [];
          const findingCount = cardList.length || reactIssues.length;
          // A recording of nothing but cheap commits is a real answer, not an
          // empty one: say so, and show the busiest commits anyway.
          const summaryLine = reactCards
            ? (reactCards.noOverBudgetCommits
              ? `No commit over the ${reactCards.budgetMs} ms budget; the busiest were ${findingCount} of ${formatMs(reactCards.peakCommitMs)} and under`
              : `${reactCards.commitsOverBudget} commit${reactCards.commitsOverBudget === 1 ? "" : "s"} over the ${reactCards.budgetMs} ms budget, of ${reactCards.commitCount}`)
              + ` · ${formatMs(reactCards.totalRenderMs)} rendering`
              + (reactCards.omittedCardCount > 0 ? ` · ${reactCards.omittedCardCount} more not shown` : "")
              + (reactCards.roots.length > 1 ? ` · ${reactCards.roots.length} roots` : "")
            : `${reactIssues.length} commit finding${reactIssues.length === 1 ? "" : "s"} · ${appliedBudget} ms budget`
              + (reactSummary ? ` · ${reactSummary.commitCount} commits · ${reactSummary.peakCommitDurationMs ?? 0} ms peak · ${reactSummary.commitsOverBudget} over budget` : "")
              + (reactSummary && reactSummary.omittedEvidenceCommitCount > 0
                ? ` · ${reactSummary.omittedEvidenceCommitCount} commits omitted from detailed analysis`
                : "");
          return (
          <>
            <button className="results-back" type="button" onClick={resetToUpload}><HeaderIcon type="back" /> Back to new analysis</button>
            <div className="results-header">
              <div className="intro">
                <span className="eyebrow">Analysis results</span>
                <h1 className="results-title">{reactCards ? "Commits, longest first" : "React issues"}</h1>
                <p>{summaryLine}</p>
                {/* Said once, at the top: every render reason on every card
                    below is unavailable rather than absent, and the fix is a
                    setting in the recorder rather than anything here. */}
                {reactCards && !reactCards.causesRecorded ? (
                  <p className="results-note">
                    This recording does not say why each component rendered. Re-record with React DevTools&rsquo;
                    &ldquo;Record why each component rendered&rdquo; setting on to get render causes.
                  </p>
                ) : null}
                {analyzerUsage && analyzerUsage.totalTokens > 0 && (
                  <p className="usage-line" title="Tokens consumed by the analyzer agent for this analysis">
                    analyzer · {formatTokens(analyzerUsage.totalTokens)} tokens · {usageBreakdown(analyzerUsage)}
                  </p>
                )}
              </div>
              <div className="result-actions">
                {reactCards ? <ChartSwitch kind={chartKind} onChange={setChartKind} /> : null}
                {analyzerUsage && analyzerUsage.totalTokens > 0 && <ResultModel model={analysisModel} usage={analyzerUsage} />}
                {!saved && analysisId ? <Button variant="outline" onClick={() => void saveCurrentAnalysis()}>Save analysis</Button> : null}
              </div>
            </div>

            <div className="hotspot-list">
              {reactCards ? cardList.map((card, index) => {
                // No component cleared the floor, so there is nothing for the
                // chart to divide the commit into; the rows still name one.
                const drawable = reactCommitSlices(card).some((slice) => slice.kind === "component");
                const { rows, footnotes } = drawable ? { rows: [], footnotes: [] } : reactCardRows(card);
                return (
                  <AnalysisResultCard
                    key={card.id}
                    rank={index + 1}
                    title={card.insight?.title ?? card.headline}
                    shape={card.shapeline}
                    timeLabel={formatMs(card.durationMs)}
                    chart={drawable
                      ? (
                        <ReactContribution
                          card={card}
                          kind={chartKind}
                          onExplore={analysisId && !isSample ? () => exploreReactCommit(card) : undefined}
                        />
                      )
                      : undefined}
                    insight={card.insight?.findings}
                    onExplain={aiAssisted && modelStatus?.configured && analysisId && !isSample ? () => void explainReactCard(card) : undefined}
                    explaining={explainingId === card.id}
                    insightError={insightErrors[card.id]}
                    rows={rows}
                    footnotes={footnotes}
                    loading={promptLoadingId === card.id}
                    error={promptErrors[card.id]}
                    copied={copiedId === card.id}
                    busy={isSample || promptLoadingId !== null}
                    onCopy={() => void copyHandoff(card.id)}
                    onExplore={analysisId && !isSample ? () => exploreReactCommit(card) : undefined}
                  />
                );
              }) : null}
              {/* Analyses saved by the model-selected engine still hold the old shape. */}
              {!reactCards && reactIssues.slice(0, MAX_RESULT_CARDS).map((issue, index) => {
                const { rows, footnotes } = reactIssueRows(issue);
                return (
                  <AnalysisResultCard
                    key={issue.id}
                    rank={index + 1}
                    title={issue.summary}
                    timeLabel={`${issue.severity} · commit ${formatMs(issue.commit.durationMs)}`}
                    rows={rows}
                    footnotes={footnotes}
                    loading={promptLoadingId === issue.id}
                    error={promptErrors[issue.id]}
                    copied={copiedId === issue.id}
                    busy={isSample || promptLoadingId !== null}
                    onCopy={() => void copyHandoff(issue.id)}
                  />
                );
              })}
            </div>
          </>
          );
        })()}

        {phase === "results" && analyzedType === "javascript" && (() => {
          const taskList = taskCards?.cards ?? [];
          const findingCount = taskList.length || cards.length || hotspots.length;
          // A recording of nothing but short work is a real answer, not an
          // empty one: say so, and show the busiest tasks anyway.
          const summaryLine = taskCards
            ? taskCards.noLongTasks
              ? `No long tasks in this recording; the busiest work was ${findingCount} ${findingCount === 1 ? "task" : "tasks"} of ${formatMs(taskList[0]?.durationMs ?? 0)} and under · ${formatMs(totalMs)} total`
              : `${findingCount} long ${findingCount === 1 ? "task" : "tasks"} of ${taskCards.taskCount} · ${formatMs(totalMs)} total`
            : `${findingCount} ${findingCount === 1 ? "finding" : "findings"} · ${formatMs(totalMs)} total`;
          return (
          <>
            <button className="results-back" type="button" onClick={resetToUpload}><HeaderIcon type="back" /> Back to new analysis</button>
            <div className="results-header">
              <div className="intro">
                <span className="eyebrow">Analysis results</span>
                <h1 className="results-title">{taskCards ? "Tasks, longest first" : "Bottlenecks, slowest first"}</h1>
                <p>{summaryLine}</p>
                {analyzerUsage && analyzerUsage.totalTokens > 0 && (
                  <p className="usage-line" title="Tokens consumed by the analyzer agent for this analysis">
                    analyzer · {formatTokens(analyzerUsage.totalTokens)} tokens · {usageBreakdown(analyzerUsage)}
                  </p>
                )}
              </div>
              <div className="result-actions">
                {taskCards ? <ChartSwitch kind={chartKind} onChange={setChartKind} /> : null}
                {analyzerUsage && analyzerUsage.totalTokens > 0 && <ResultModel model={analysisModel} usage={analyzerUsage} />}
                {!saved && analysisId ? <Button variant="outline" onClick={() => void saveCurrentAnalysis()}>Save analysis</Button> : null}
              </div>
            </div>

            <div className="hotspot-list">
              {taskCards ? taskList.map((card, index) => {
                const footnotes = taskCardFootnotes(card);
                // No frame of their own means nothing to divide the task into.
                const rows = card.boundaryFrames.length === 0
                  ? taskFallbackRows(card, (nodeId) => exploreTask(card, nodeId))
                  : [];
                return (
                  <AnalysisResultCard
                    key={card.id}
                    rank={index + 1}
                    title={card.pathline ?? card.headline}
                    shape={card.shapeline}
                    timeLabel={formatMs(card.durationMs)}
                    chart={rows.length === 0
                      ? <TaskContribution card={card} kind={chartKind} onFocus={(nodeId) => exploreTask(card, nodeId)} />
                      : undefined}
                    insight={card.insight?.findings}
                    onExplain={aiAssisted && modelStatus?.configured && analysisId && !isSample ? () => void explainTask(card) : undefined}
                    explaining={explainingId === card.id}
                    insightError={insightErrors[card.id]}
                    rows={rows}
                    footnotes={footnotes}
                    loading={promptLoadingId === card.id}
                    error={promptErrors[card.id]}
                    copied={copiedId === card.id}
                    busy={isSample || promptLoadingId !== null}
                    onCopy={() => void copyHandoff(card.id)}
                    onExplore={analysisId ? () => exploreTask(card) : undefined}
                  />
                );
              }) : null}
              {/* The node-descent engine, served under TRACESIFT_CPU_ENGINE=cards. */}
              {!taskCards && cards.map((card, index) => {
                const { rows, footnotes } = cardRows(card);
                return (
                <AnalysisResultCard
                  key={card.id}
                  rank={index + 1}
                  title={card.headline}
                  timeLabel={formatMs(card.totalMs)}
                  subtitle={cardSubtitle(card, callCountIsExact)}
                  rows={rows}
                  footnotes={footnotes}
                  loading={promptLoadingId === card.id}
                  error={promptErrors[card.id]}
                  copied={copiedId === card.id}
                  busy={isSample || promptLoadingId !== null}
                  onCopy={() => void copyHandoff(card.id)}
                  onExplore={analysisId ? () => exploreCard(card) : undefined}
                />
                );
              })}
              {/* Analyses saved before the call-tree engine still hold the old shape. */}
              {!taskCards && cards.length === 0 && hotspots.map((hotspot, index) => {
                const { rows, footnotes } = hotspotRows(hotspot);
                return (
                <AnalysisResultCard
                  key={hotspot.id}
                  rank={index + 1}
                  title={hotspot.title}
                  timeLabel={formatMs(hotspot.combinedTimeMs)}
                  subtitle={occurrenceLabel(hotspot)}
                  rows={rows}
                  footnotes={footnotes}
                  loading={promptLoadingId === hotspot.id}
                  error={promptErrors[hotspot.id]}
                  copied={copiedId === hotspot.id}
                  busy={isSample || promptLoadingId !== null}
                  onCopy={() => void copyHandoff(hotspot.id)}
                />
                );
              })}
            </div>
          </>
          );
        })()}
      </section>
      </PluginShell.Body>
    </PluginShell>
  );
}
