import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdir, chmod, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** @typedef {'openai' | 'anthropic' | 'apex'} ProviderId */
/** @typedef {{version: 1, provider: ProviderId, model: string, keys: Partial<Record<ProviderId, string>>}} ModelConfig */

export const providers = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic', apex: 'Callstack (Apex)' });
/** Resolve the managed installation and configuration directory. */
export function getHome() { return resolve(/* turbopackIgnore: true */ process.env.PERF_AI_HOME || join(homedir(), '.perf-ai')); }
export async function ensureHome(home = getHome()) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
}
export function validateConfig(value) {
  if (!value || value.version !== 1 || !Object.hasOwn(providers, value.provider) || typeof value.model !== 'string' || !value.model.trim() || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys) || Object.entries(value.keys).some(([p, k]) => !Object.hasOwn(providers, p) || typeof k !== 'string' || !k.trim()) || !value.keys[value.provider]) {
    throw new Error('Invalid model configuration. Run perf-ai model to configure it.');
  }
  return { version: 1, provider: value.provider, model: value.model, keys: { ...value.keys } };
}
/** @returns {Promise<ModelConfig | null>} */
export async function readConfig(home = getHome()) {
  let raw;
  try { raw = await readFile(join(home, 'config.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read model configuration. Check permissions on config.json.'); }
  try { return validateConfig(JSON.parse(raw)); }
  catch { throw new Error('Invalid model configuration. Run perf-ai model to replace it.'); }
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
