import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdir, chmod, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** @typedef {'openai' | 'openai-codex' | 'anthropic' | 'apex'} ProviderId */
/** @typedef {{version: 2, provider: ProviderId, model: string, authMode: 'api_key' | 'oauth', keys: Partial<Record<'openai' | 'anthropic' | 'apex', string>>}} ModelConfig */

export const providers = Object.freeze({ openai: 'OpenAI', 'openai-codex': 'ChatGPT Codex', anthropic: 'Anthropic', apex: 'Callstack' });
export const keyProviders = Object.freeze(['openai', 'anthropic', 'apex']);
/** Resolve the managed installation and configuration directory. */
export function getHome() { return resolve(/* turbopackIgnore: true */ process.env.TRACE_SIFT_HOME || join(homedir(), '.tracesift')); }
export async function ensureHome(home = getHome()) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
}
/** HTTP auth headers only accept ASCII; pasted keys often pick up em dashes from rich text. */
export function isAsciiApiKey(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 127) return false;
  return true;
}

export function validateConfig(value) {
  const keys = value?.keys;
  const keyEntries = keys && typeof keys === 'object' && !Array.isArray(keys) ? Object.entries(keys) : null;
  if (keyEntries?.some(([, k]) => typeof k === 'string' && k.trim() && !isAsciiApiKey(k))) {
    throw new Error('API keys must be plain ASCII. Copy the key again from the provider dashboard; rich text often turns a hyphen into a dash. Replace it in Analysis settings.');
  }
  const authMode = value?.version === 1 ? 'api_key' : value?.authMode;
  if (!value || ![1, 2].includes(value.version) || !Object.hasOwn(providers, value.provider) || typeof value.model !== 'string' || !value.model.trim() || !['api_key', 'oauth'].includes(authMode) || !keyEntries || keyEntries.some(([p, k]) => !keyProviders.includes(p) || typeof k !== 'string' || !k.trim()) || (authMode === 'api_key' && !value.keys[value.provider]) || (authMode === 'oauth' && !['openai-codex', 'anthropic'].includes(value.provider))) {
    throw new Error('Invalid model configuration. Replace it in Analysis settings.');
  }
  return { version: 2, provider: value.provider, model: value.model, authMode, keys: { ...value.keys } };
}
/** @returns {Promise<ModelConfig | null>} */
export async function readConfig(home = getHome()) {
  let raw;
  try { raw = await readFile(join(home, 'config.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read model configuration. Check permissions on config.json.'); }
  try {
    const parsed = JSON.parse(raw);
    const config = validateConfig(parsed);
    if (parsed.version === 1) await writeConfig(config, home);
    return config;
  }
  catch (error) {
    if (error instanceof Error && error.message.includes('plain ASCII')) throw error;
    throw new Error('Invalid model configuration. Replace it in Analysis settings.');
  }
}
/** @param {ModelConfig} value */
export async function writeConfig(value, home = getHome()) {
  const config = validateConfig(value);
  await ensureHome(home);
  const temporary = join(home, `.config-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(home, 'config.json'));
  } finally { await rm(temporary, { force: true }); }
}
export async function deleteConfig(home = getHome()) {
  await rm(join(home, 'config.json'), { force: true });
}
