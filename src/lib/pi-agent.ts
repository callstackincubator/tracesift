import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getConfiguredRuntime } from "@callstack/tracesift/runtime";
import type { TokenUsage } from "./analysis";

/** Error with an HTTP status so route handlers can map failures 1:1. */
export class AgentError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AgentError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

/** Everything the PI agent does is logged here — watch `next dev` output. */
function log(label: string, ...parts: unknown[]): void {
  console.log(`[tracesift] ${new Date().toISOString()} [${label}]`, ...parts);
}

function truncate(value: unknown, max = 400): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
  } catch {
    return String(value);
  }
}

/** Coerce a provider-reported token count into a safe non-negative number. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Keep at most a couple of agent runs in flight; the rest wait in line. */
const MAX_CONCURRENT_AGENTS = 2;
let activeRuns = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeRuns < MAX_CONCURRENT_AGENTS) {
    activeRuns += 1;
    return Promise.resolve();
  }
  log("agent", "concurrency limit reached, waiting for a slot…");
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot(): void {
  activeRuns -= 1;
  const next = waitQueue.shift();
  if (next) next();
}

/** Extract the concatenated text blocks from an assistant message. */
function assistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (block): block is { type: string; text: string } =>
        Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text"
    )
    .map((block) => block.text)
    .join("");
}

function isAuthFailure(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes("401") ||
    text.includes("unauthorized") ||
    text.includes("invalid api key") ||
    text.includes("invalid_api_key") ||
    text.includes("authentication") ||
    text.includes("api key")
  );
}

function isNonAsciiApiKeyFailure(detail: string): boolean {
  const text = detail.toLowerCase();
  return text.includes("bytestring") || (text.includes("character at index") && text.includes("greater than 255"));
}

const NON_ASCII_API_KEY_MESSAGE =
  "The saved API key contains non-ASCII characters (often an em dash copied from rich text), so the provider request cannot be sent. Replace it in Analysis settings with a key copied directly from the provider dashboard.";

export interface RunAgentOptions {
  /** Short label used in the logs, e.g. "analyze" or "hotspot-prompt". */
  label: string;
  systemPrompt: string;
  prompt: string;
  /** Working directory the agent sees (profile files live here). */
  cwd: string;
  customTools?: ToolDefinition[];
  builtinTools?: string[];
  /** Per-request output budget; omitted uses the model default. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  timeoutMessage?: string;
}

export interface RunAgentResult {
  finalText: string;
  /** Number of assistant turns the agent took. */
  turns: number;
  /** Names of the tools the agent called, in order. */
  toolCalls: string[];
  /** How the final assistant message ended (end_turn | max_tokens | error | …). */
  lastStopReason: string | undefined;
  /** Token usage summed over all assistant messages of the run. */
  usage: TokenUsage;
}

/**
 * Spawns a short-lived, tool-enabled PI agent session against the configured model,
 * runs one prompt and resolves with the final assistant text.
 * Structured output is captured by the caller's custom tools.
 * Every turn, tool call and model message is logged to the server console.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const {
    label,
    systemPrompt,
    prompt,
    cwd,
    customTools = [],
    builtinTools = ["read", "bash"],
    maxOutputTokens,
    timeoutMs = 480_000,
    timeoutMessage = "The analysis agent timed out. Try a smaller profile, or run it again.",
  } = options;
  const logPrefix = `agent:${label}`;
  const startedAt = Date.now();

  const state = await getConfiguredRuntime().catch((error: Error) => {
    throw new AgentError(503, error.message);
  });
  const { runtime, model, agentDir } = state;
  log(
    logPrefix,
    `starting agent — model ${model.provider}/${model.id} (api=${model.api}, baseUrl=${model.baseUrl}), tools=[${[
      ...builtinTools,
      ...customTools.map((tool) => tool.name),
    ].join(", ")}], cwd=${cwd}, timeout=${Math.round(timeoutMs / 1000)}s, prompt=${prompt.length} chars`
  );

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // Keep these runs deterministic: no user extensions, skills, prompts,
    // themes or AGENTS.md context files are relevant to profile analysis.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
  });
  await resourceLoader.reload();

  await acquireSlot();
  let session: AgentSession | undefined;
  try {
    session = (
      await createAgentSession({
        cwd,
        model,
        thinkingLevel: "off",
        modelRuntime: runtime,
        tools: [...builtinTools, ...customTools.map((tool) => tool.name)],
        customTools,
        resourceLoader,
        sessionManager: SessionManager.inMemory(),
        settingsManager,
      })
    ).session;

    // Override the request budget without mutating the shared model registration.
    const streamFunction = session.agent.streamFunction;
    session.agent.streamFunction = (requestModel, context, options) => streamFunction(requestModel, context, {
      ...options,
      ...(maxOutputTokens === undefined ? {} : { maxTokens: Math.min(maxOutputTokens, requestModel.maxTokens) }),
    });
    const onPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, requestModel) => {
      const transformed = await onPayload?.(payload, requestModel);
      const outgoing = transformed ?? payload;
      log(logPrefix, `provider request dispatched after ${Date.now() - startedAt} ms; payloadBytes=${Buffer.byteLength(JSON.stringify(outgoing), "utf8")}, maxOutputTokens=${maxOutputTokens ?? model.maxTokens}`);
      return outgoing;
    };
    const onResponse = session.agent.onResponse;
    session.agent.onResponse = async (response, requestModel) => {
      log(logPrefix, `provider HTTP status=${response.status} after ${Date.now() - startedAt} ms`);
      await onResponse?.(response, requestModel);
    };

    let finalText = "";
    let lastError: string | undefined;
    let lastStopReason: string | undefined;
    const toolCalls: string[] = [];
    let turnCount = 0;
    let receivedDelta = false;
    let abortedByTimeout = false;
    const usageTotals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };

    const unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          log(logPrefix, "agent run started");
          break;
        case "turn_start":
          receivedDelta = false;
          turnCount += 1;
          log(logPrefix, `turn ${turnCount} started`);
          break;
        case "turn_end":
          log(logPrefix, `turn ${turnCount} ended`);
          break;
        case "tool_execution_start":
          toolCalls.push(event.toolName);
          log(logPrefix, `tool call → ${event.toolName} args=${truncate(event.args, 300)}`);
          break;
        case "tool_execution_end":
          log(
            logPrefix,
            `tool result ← ${event.toolName} ${event.isError ? "ERROR" : "ok"}: ${truncate(event.result, 300)}`
          );
          break;
        case "message_update":
          if (!receivedDelta && event.assistantMessageEvent.type.endsWith("_delta")) {
            receivedDelta = true;
            log(logPrefix, `first streamed output for turn ${turnCount} after ${Date.now() - startedAt} ms`);
          }
          break;
        case "message_end": {
          const message = event.message as {
            role?: string;
            stopReason?: string;
            errorMessage?: string;
            usage?: {
              input?: unknown;
              output?: unknown;
              cacheRead?: unknown;
              cacheWrite?: unknown;
              totalTokens?: unknown;
              cost?: { total?: unknown };
            };
            model?: string;
            content?: unknown;
            toolName?: string;
            isError?: boolean;
          };
          if (message.role === "assistant") {
            const text = assistantText({ content: message.content });
            finalText = text || finalText;
            lastStopReason = message.stopReason ?? lastStopReason;
            if (message.usage) {
              usageTotals.input += num(message.usage.input);
              usageTotals.output += num(message.usage.output);
              usageTotals.cacheRead += num(message.usage.cacheRead);
              usageTotals.cacheWrite += num(message.usage.cacheWrite);
              usageTotals.totalTokens += num(message.usage.totalTokens);
              usageTotals.costUsd += num(message.usage.cost?.total);
            }
            log(
              logPrefix,
              `assistant message: stopReason=${message.stopReason ?? "?"}, model=${message.model ?? "?"}, ` +
                `outputTokens=${truncate(message.usage, 120)}, text=${text.length} chars`
            );
            if (text) log(logPrefix, `assistant text: ${truncate(text, 600)}`);
            if (message.errorMessage) log(logPrefix, `assistant error: ${truncate(message.errorMessage, 800)}`);
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              lastError = message.errorMessage ?? lastError;
            }
            if (message.stopReason === "max_tokens") {
              log(logPrefix, "WARNING: assistant message was cut off at the model's max output tokens");
            }
          } else if (message.role === "toolResult") {
            log(logPrefix, `tool result recorded: ${message.toolName ?? "?"} ${message.isError ? "(error)" : "(ok)"}`);
          }
          break;
        }
        default:
          break;
      }
    });

    const timer = setTimeout(() => {
      abortedByTimeout = true;
      log(logPrefix, `TIMEOUT after ${timeoutMs} ms — aborting session`);
      void session?.abort();
    }, timeoutMs);

    try {
      await session.prompt(prompt);
    } catch (error) {
      if (abortedByTimeout) throw new AgentError(504, timeoutMessage);
      const detail = error instanceof Error ? error.message : String(error);
      log(logPrefix, `session.prompt threw: ${truncate(detail, 800)}`);
      if (isAuthFailure(detail)) {
        throw new AgentError(401, "The API key was rejected by the provider. Replace it in Analysis settings.");
      }
      if (isNonAsciiApiKeyFailure(detail)) {
        throw new AgentError(401, NON_ASCII_API_KEY_MESSAGE);
      }
      throw new AgentError(502, `The analysis agent failed: ${detail}`);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }

    log(
      logPrefix,
      `agent finished after ${Math.round((Date.now() - startedAt) / 1000)}s — ${turnCount} turn(s), tools=[${toolCalls.join(", ") || "none"}], lastStopReason=${lastStopReason ?? "?"}, ` +
        `tokens: total=${usageTotals.totalTokens} input=${usageTotals.input} output=${usageTotals.output} cacheRead=${usageTotals.cacheRead} cacheWrite=${usageTotals.cacheWrite} cost=$${usageTotals.costUsd.toFixed(6)}`
    );

    if (abortedByTimeout) {
      throw new AgentError(504, timeoutMessage);
    }
    if (lastError) {
      if (isAuthFailure(lastError)) {
        throw new AgentError(401, "The API key was rejected by the provider. Replace it in Analysis settings.");
      }
      if (isNonAsciiApiKeyFailure(lastError)) {
        throw new AgentError(401, NON_ASCII_API_KEY_MESSAGE);
      }
      throw new AgentError(502, `The analysis agent failed: ${lastError}`);
    }
    if (lastStopReason === "max_tokens") {
      throw new AgentError(
        502,
        "The agent's response was cut off at the model's output token limit before it finished. Try again."
      );
    }

    return { finalText, turns: turnCount, toolCalls, lastStopReason, usage: usageTotals };
  } finally {
    session?.dispose();
    releaseSlot();
  }
}
