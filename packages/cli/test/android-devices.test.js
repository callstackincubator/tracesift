import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildEnv, listAndroidDevices, resolveAdb, resolveSdkRoot } from '../src/android-devices.js';

/** An SDK tree with a runnable platform-tools/adb in it. */
async function fakeSdk() {
  const root = await mkdtemp(join(tmpdir(), 'tracesift-sdk-'));
  await mkdir(join(root, 'platform-tools'), { recursive: true });
  const adb = join(root, 'platform-tools', 'adb');
  await writeFile(adb, '#!/bin/sh\nexit 0\n');
  await chmod(adb, 0o755);
  return root;
}

const LISTING = `List of devices attached
R5CT83DJM1Z            device usb:0-1 product:b0qxxx model:SM_S908E device:b0q transport_id:4
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2
ZY3300ABCD             unauthorized usb:0-2 transport_id:5
`;

test('devices are listed with the name the device calls itself', async () => {
  const names = { R5CT83DJM1Z: 'SM-S908E', 'emulator-5554': 'Pixel_7_API_34' };
  const devices = await listAndroidDevices(async (_command, args) => {
    if (args[0] === 'devices') return LISTING;
    const [, serial, , , property] = args;
    if (property === 'ro.product.model') return `${names[serial]}\n`;
    if (property === 'ro.boot.qemu.avd_name' && serial.startsWith('emulator-')) return `${names[serial]}\n`;
    return '\n';
  });
  assert.deepEqual(devices, [
    { kind: 'android', id: 'R5CT83DJM1Z', name: 'SM-S908E', note: 'USB' },
    { kind: 'android', id: 'emulator-5554', name: 'Pixel 7 API 34', note: 'emulator' },
    { kind: 'android', id: 'ZY3300ABCD', name: 'ZY3300ABCD', note: 'authorise USB debugging on the device' },
  ]);
});

test('an unreachable device keeps the name adb listed for it', async () => {
  const devices = await listAndroidDevices(async (_command, args) => {
    if (args[0] === 'devices') return 'List of devices attached\nR5CT83DJM1Z  device model:SM_S908E\n';
    throw new Error('the device stopped answering');
  });
  assert.deepEqual(devices, [{ kind: 'android', id: 'R5CT83DJM1Z', name: 'SM_S908E', note: 'USB' }]);
});

test('no adb means no Android devices rather than a failure', async () => {
  assert.deepEqual(await listAndroidDevices(async () => { throw new Error('adb is not installed'); }), []);
});

test('adb is found in the SDK when PATH has none', async () => {
  const root = await fakeSdk();
  const env = { PATH: '/nowhere-at-all', ANDROID_HOME: root };
  assert.equal(await resolveAdb(env), join(root, 'platform-tools', 'adb'));
  assert.equal(await resolveSdkRoot(env), root);
});

test('an SDK the environment names but does not have is not used', async () => {
  // Whether anything is found instead depends on the machine; what matters is
  // that Gradle is never pointed at a directory that is not there.
  const missing = join(tmpdir(), 'tracesift-sdk-that-is-not-there');
  const env = { PATH: '/nowhere-at-all', ANDROID_HOME: missing };
  assert.notEqual(await resolveSdkRoot(env), missing);
  assert.notEqual(await resolveAdb(env), join(missing, 'platform-tools', 'adb'));
});

test('a build environment gains this Node and the SDK without displacing either', async () => {
  const root = await fakeSdk();
  const built = await buildEnv({ PATH: '/usr/bin:/bin', ANDROID_HOME: root });
  const entries = built.PATH.split(':');
  assert.deepEqual(entries.slice(0, 2), ['/usr/bin', '/bin'], 'what was there stays first');
  assert.ok(entries.includes(join(root, 'platform-tools')));
  assert.ok(entries.some((entry) => entry === new URL('.', `file://${process.execPath}`).pathname.replace(/\/$/, '')));
  assert.equal(built.ANDROID_HOME, root, 'a named SDK is left alone');
});

test('an environment with no SDK of its own is given the one that is installed', async () => {
  const root = await fakeSdk();
  const built = await buildEnv({ PATH: '/usr/bin', ANDROID_SDK_ROOT: root });
  assert.equal(built.ANDROID_HOME, root);
});
