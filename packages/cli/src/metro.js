const MAX_BODY_CHARS = 1024 * 1024;
const MAX_TARGETS = 100;
const MAX_FIELD_CHARS = 512;
const DISCOVERY_TIMEOUT_MS = 5000;
const DEFAULT_METRO_PORT = 8081;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'];
// The inspector proxy advertises itself on loopback only, so a debugger URL that
// names anything else is either a misconfiguration or an attempt to make us
// connect somewhere the developer never chose.
const DEBUGGER_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   appId?: string,
 *   deviceName?: string,
 *   deviceId?: string,
 *   vm?: string,
 *   webSocketDebuggerUrl: string,
 *   supportsMultipleDebuggers: boolean,
 * }} MetroTarget
 */

/** Default Metro origin, honouring RCT_METRO_PORT. */
export function defaultMetroOrigin() {
  const raw = process.env.RCT_METRO_PORT;
  const port = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535;
  return `http://127.0.0.1:${valid ? port : DEFAULT_METRO_PORT}`;
}

/**
 * Validate a user-supplied Metro origin. `localhost:8081` has no scheme, and
 * `new URL` would read `localhost:` as one, so add the default before parsing.
 * @param {string} value
 * @returns {URL}
 */
export function parseMetroOrigin(value) {
  const text = String(value ?? '').trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('Metro URL must be an http or https address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Metro URL must be an http or https address.');
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error(`Metro URL must point at localhost; ${url.hostname} is not a loopback address.`);
  }
  return url;
}

function originLabel(origin) {
  const url = origin instanceof URL ? origin : parseMetroOrigin(origin);
  return url.href.replace(/\/$/, '');
}

function clamp(value) {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_CHARS) : undefined;
}

function notMetro(label) {
  return new Error(`${label} answered, but it is not a Metro server (no inspector target list). Check the port with --metro.`);
}

/**
 * Turn one `/json/list` item into a target, or null when it is not one we may
 * connect to. Anything that fails validation is dropped rather than reported:
 * a stale or foreign entry should not hide the apps that are fine.
 */
function toTarget(item, base) {
  if (!item || typeof item.id !== 'string' || typeof item.webSocketDebuggerUrl !== 'string') return null;
  let url;
  try {
    url = new URL(item.webSocketDebuggerUrl, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' || !DEBUGGER_HOSTS.includes(url.hostname) || url.username || url.password || url.hash) return null;
  // An inspector may report localhost while discovery used 127.0.0.1, but never another port.
  if (url.port !== base.port) return null;
  return {
    id: clamp(item.id),
    title: clamp(item.title) ?? clamp(item.id),
    appId: clamp(item.appId),
    deviceName: clamp(item.deviceName),
    deviceId: clamp(item.reactNative?.logicalDeviceId),
    vm: clamp(item.vm),
    webSocketDebuggerUrl: url.href,
    supportsMultipleDebuggers: item.reactNative?.capabilities?.supportsMultipleDebuggers === true,
  };
}

/**
 * List the debuggable targets Metro's inspector proxy knows about.
 * @param {string | URL} origin
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<MetroTarget[]>}
 */
export async function metroTargets(origin, { signal } = {}) {
  const base = origin instanceof URL ? origin : parseMetroOrigin(origin);
  const label = originLabel(base);
  let response;
  let body;
  try {
    response = await fetch(new URL('/json/list', base), {
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
    if (response.ok) body = await response.text();
  } catch {
    throw new Error(
      `No Metro server is listening on ${label}. Start it with \`npx react-native start\` (or \`npx expo start\`), then run this again. Point at another port with --metro.`,
    );
  }
  if (!response.ok) throw notMetro(label);
  if (body.length > MAX_BODY_CHARS) throw new Error('Metro returned too many targets.');
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw notMetro(label);
  }
  if (!Array.isArray(payload)) throw notMetro(label);
  return payload.slice(0, MAX_TARGETS).flatMap((item) => {
    const target = toTarget(item, base);
    return target ? [target] : [];
  });
}

/**
 * One-line human label, e.g. `AwesomeApp (Hermes) — iPhone 17 Pro`.
 * @param {MetroTarget} target
 */
export function describeMetroTarget(target) {
  let text = target.title || target.appId || target.id;
  if (target.vm) text += ` (${target.vm})`;
  if (target.deviceName) text += ` — ${target.deviceName}`;
  return text;
}

function sameText(a, b) {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Pick the one app to record. Pure, so the ambiguity rules are testable without
 * a Metro server. The proxy lists the freshest connection last, so a reloaded
 * app that left a stale entry behind resolves to its newest session.
 * @param {MetroTarget[]} targets
 * @param {{ app?: string, device?: string, targetId?: string, origin?: string | URL }} [options]
 * @returns {MetroTarget}
 */
export function selectMetroTarget(targets, { app, device, targetId, origin } = {}) {
  if (targets.length === 0) {
    throw new Error(
      `Metro is running on ${origin ? originLabel(origin) : 'the Metro address'}, but no app is connected to it. ` +
        'Launch the app in a simulator, emulator or device and wait for the bundle to finish loading, then run this again.',
    );
  }
  const selector = targetId ? ['target-id', targetId] : app ? ['app', app] : device ? ['device', device] : null;
  let candidates = targets.filter(
    (target) =>
      (!targetId || target.id === targetId) &&
      (!app || target.appId === app || sameText(target.title, app)) &&
      (!device || sameText(target.deviceName, device)),
  );
  if (candidates.length === 0) {
    throw new Error(
      `No app connected to Metro matches --${selector[0]} ${selector[1]}. Run \`tracesift record targets --platform rn\` to see what is connected.`,
    );
  }
  if (!selector) {
    candidates = candidates.filter((target) => !target.vm || /hermes/i.test(target.vm));
    if (candidates.length === 0) {
      throw new Error('That app runs on JavaScriptCore, which has no sampling profiler. Switch it to Hermes (the React Native default) and record again.');
    }
  }
  const key = (target) => `${target.deviceId ?? ''}|${target.appId ?? ''}`;
  const last = new Map();
  candidates.forEach((target, index) => last.set(key(target), index));
  candidates = candidates.filter((target, index) => key(target) === '|' || last.get(key(target)) === index);
  if (candidates.length === 1) return candidates[0];
  const lines = candidates.map((target) => `  ${describeMetroTarget(target)} — --target-id ${target.id}`);
  throw new Error([`Metro has ${candidates.length} connected apps. Choose one with --app, --device or --target-id:`, ...lines].join('\n'));
}
