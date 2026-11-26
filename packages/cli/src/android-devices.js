// Android devices, as adb reports them, and finding adb in the first place.
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { capture } from './ios-devices.js';

/** Where an SDK lives when nothing on PATH or in the environment says so. */
function defaultSdkRoots() {
  const home = homedir();
  return [
    join(home, 'Library', 'Android', 'sdk'),
    join(home, 'Android', 'Sdk'),
    join(home, 'AppData', 'Local', 'Android', 'Sdk'),
  ];
}

async function exists(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The adb to run. */
export async function resolveAdb(env = process.env) {
  const binary = process.platform === 'win32' ? 'adb.exe' : 'adb';
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry && await exists(join(entry, binary))) return binary;
  }
  const root = await resolveSdkRoot(env);
  if (root) {
    const candidate = join(root, 'platform-tools', binary);
    if (await exists(candidate)) return candidate;
  }
  return binary;
}

/** The Android SDK, as the environment names it or as it is usually installed. */
export async function resolveSdkRoot(env = process.env) {
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, ...defaultSdkRoots()]) {
    if (root && await exists(join(root, 'platform-tools'))) return root;
  }
  return undefined;
}

/** An environment a child can build an Android app in. */
export async function buildEnv(env = process.env) {
  const extra = [dirname(process.execPath)];
  const root = await resolveSdkRoot(env);
  if (root) extra.push(join(root, 'platform-tools'));
  const existing = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const path = [...existing, ...extra.filter((entry) => !existing.includes(entry))].join(delimiter);
  return {
    ...env,
    PATH: path,
    ...(root && !env.ANDROID_HOME ? { ANDROID_HOME: root } : {}),
  };
}

/** Attached Android devices and running emulators, as `{ kind, id, name, note }` — the same shape
 * `profile devices` prints for iOS, because the panel lists them side by side. */
export async function listAndroidDevices(execCapture = capture) {
  let output;
  try {
    output = await execCapture(await resolveAdb(), ['devices', '-l']);
  } catch {
    return [];
  }
  const listed = [];
  for (const line of output.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, state, ...rest] = trimmed.split(/\s+/);
    if (!id || !state) continue;
    const fields = new Map(rest.filter((field) => field.includes(':')).map((field) => {
      const index = field.indexOf(':');
      return [field.slice(0, index), field.slice(index + 1)];
    }));
    listed.push({ id, state, model: fields.get('model') });
  }
  return Promise.all(listed.map(async (device) => {
    const emulator = device.id.startsWith('emulator-');
    return {
      kind: 'android',
      id: device.id,
      // `adb devices -l` reports the model with every punctuation mark turned into an underscore,
      // so SM-S908E arrives as SM_S908E.
      name: (device.state === 'device' ? await readName(device.id, emulator, execCapture) : '')
        || device.model
        || (emulator ? 'Android emulator' : device.id),
      note: androidNote(device.state, emulator),
    };
  }));
}

/** The device's own name for itself: an emulator's AVD, a phone's model. */
async function readName(id, emulator, execCapture) {
  const properties = emulator
    ? ['ro.boot.qemu.avd_name', 'ro.kernel.qemu.avd_name', 'ro.product.model']
    : ['ro.product.model'];
  for (const property of properties) {
    try {
      const value = (await execCapture(await resolveAdb(), ['-s', id, 'shell', 'getprop', property])).trim();
      if (value) return emulator && property !== 'ro.product.model' ? value.replace(/_/g, ' ') : value;
    } catch {
      // An unreachable device simply has no name of its own to offer.
    }
  }
  return '';
}

/** What to say about a device adb can see but may not be able to use. */
function androidNote(state, emulator) {
  if (state === 'unauthorized') return 'authorise USB debugging on the device';
  if (state === 'offline') return 'offline — reconnect it';
  if (state !== 'device') return state;
  return emulator ? 'emulator' : 'USB';
}
