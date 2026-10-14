import { readFile, realpath, stat } from 'node:fs/promises';
import { getHome } from './config.js';
import { readActiveService } from './service.js';
import { openBrowser } from './start.js';

const MAX_ANALYSIS_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9-]{1,100}$/;

function cards(value) {
  if (Array.isArray(value?.cards)) return value.cards;
  if (Array.isArray(value?.taskCards?.cards)) return value.taskCards.cards;
  return [];
}

/** Read the compact integration analysis (or a saved native analysis) named by the CLI. */
export async function readExploreAnalysis(path) {
  const resolved = await realpath(path).catch(() => { throw new Error('The analysis path does not exist or is not readable.'); });
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error('The analysis path must point to a regular file.');
  if (metadata.size > MAX_ANALYSIS_BYTES) throw new Error('The analysis file is too large to be an Explore handoff.');
  let value;
  try { value = JSON.parse(await readFile(resolved, 'utf8')); }
  catch { throw new Error('The analysis file is not valid JSON.'); }
  const analysisId = value?.analysisId ?? value?.id;
  if (!SAFE_ID.test(analysisId ?? '') || (value?.profileType !== undefined && !['cpu', 'react'].includes(value.profileType))) {
    throw new Error('The analysis file is not a supported TraceSift analysis.');
  }
  return { analysisId, profileType: value?.profileType, cards: cards(value) };
}

export function parseTaskIndex(value) {
  if (!/^\d+$/.test(value ?? '')) throw new Error('--task must be a non-negative integer.');
  return Number(value);
}

export function parseCommit(value) {
  const match = /^(\d+)\.(\d+)$/.exec(value ?? '');
  if (!match) throw new Error('--commit must be a root id and commit index such as 1.2.');
  const rootId = Number(match[1]);
  const commitIndex = Number(match[2]);
  if (!Number.isSafeInteger(rootId) || !Number.isSafeInteger(commitIndex)) {
    throw new Error('--commit must contain safe non-negative integers.');
  }
  return { rootId, commitIndex };
}

async function openExplore(home, fetchImpl, browser, params) {
  const service = await readActiveService(home, fetchImpl);
  const url = new URL('/explore', service.baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const opened = await browser(url.toString());
  if (opened === false) throw new Error(`Could not open a browser. Open ${url} manually.`);
  return url.toString();
}

export async function explore(path, { task, commit, focus, home = getHome(), fetchImpl = fetch, browser = openBrowser } = {}) {
  const analysis = await readExploreAnalysis(path);
  if (task !== undefined && commit !== undefined) throw new Error('Choose either --task or --commit, not both.');
  if (commit !== undefined) {
    if (focus !== undefined) throw new Error('--focus is only supported with --task.');
    const selected = parseCommit(commit);
    const card = analysis.cards.find(entry => entry?.rootId === selected.rootId && entry?.commitIndex === selected.commitIndex);
    if (analysis.cards.length > 0 && !card) throw new Error('That React commit is not present in the analysis file.');
    return openExplore(home, fetchImpl, browser, { a: analysis.analysisId, commit: `${selected.rootId}.${selected.commitIndex}` });
  }
  const taskIndex = task === undefined
    ? (analysis.cards.length === 1 ? analysis.cards[0]?.taskIndex : undefined)
    : parseTaskIndex(task);
  if (!Number.isSafeInteger(taskIndex) || taskIndex < 0) {
    throw new Error('Choose a task with `--task <index>`.');
  }
  const card = analysis.cards.find(entry => entry?.taskIndex === taskIndex);
  if (analysis.cards.length > 0 && !card) throw new Error('That task is not present in the analysis file.');
  if (focus !== undefined && (typeof focus !== 'string' || !focus || focus.length > 16_384)) {
    throw new Error('--focus must name a function node from the selected task.');
  }
  if (focus && card) {
    const nodeIds = new Set([
      ...(card.culprits ?? []).map(entry => entry?.nodeId),
      ...(card.boundaryFrames ?? []).flatMap(entry => [entry?.nodeId, ...(entry?.culprits ?? []).map(child => child?.nodeId), ...(entry?.inside ?? []).map(child => child?.nodeId)]),
    ].filter(Boolean));
    if (!nodeIds.has(focus)) throw new Error('That function is not present in the selected task.');
  }
  const params = { a: analysis.analysisId, task: String(taskIndex) };
  if (focus) params.focus = focus;
  return openExplore(home, fetchImpl, browser, params);
}
