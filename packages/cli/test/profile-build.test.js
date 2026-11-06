import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assembleTask, assertProfileOptions, detectPackageManager, installArgs,
  profileBuild, readApkMetadata, sourceMapPathFor, PROFILER_PACKAGE,
} from '../src/profile-build.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tracesift-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A React Native project just real enough: package.json, gradlew, apk metadata. */
async function fakeProject(t, { variant = 'release', lockfile = 'package-lock.json', sourceMap = true } = {}) {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, 'package.json'), '{"name":"spike"}');
  await writeFile(join(root, lockfile), '');
  await mkdir(join(root, 'android'), { recursive: true });
  await writeFile(join(root, 'android', 'gradlew'), '');

  const outputs = join(root, 'android', 'app', 'build', 'outputs', 'apk', variant);
  await mkdir(outputs, { recursive: true });
  await writeFile(join(outputs, 'output-metadata.json'), JSON.stringify({
    applicationId: 'com.spikeapp',
    elements: [{ outputFile: 'app-release.apk' }],
  }));

  if (sourceMap) {
    const maps = join(root, 'android', 'app', 'build', 'generated', 'sourcemaps', 'react', variant);
    await mkdir(maps, { recursive: true });
    await writeFile(join(maps, 'index.android.bundle.map'), '{}');
  }
  return root;
}

/** Record every command instead of running it. */
function recorder() {
  const calls = [];
  return {
    calls,
    exec: async (command, args, options) => { calls.push({ command, args, cwd: options?.cwd }); },
    execCapture: async () => 'com.spikeapp/.MainActivity\n',
  };
}

test('assembleTask capitalises the variant and refuses anything that is not one', () => {
  assert.equal(assembleTask('release'), 'assembleRelease');
  assert.equal(assembleTask('profiling'), 'assembleProfiling');
  assert.equal(assembleTask('prodRelease'), 'assembleProdRelease');
  for (const bad of ['', 'Release', 'release; rm -rf /', '--stacktrace', 'a b']) {
    assert.throws(() => assembleTask(bad), /must be a Gradle variant name/, `rejects ${JSON.stringify(bad)}`);
  }
});

test('the package manager is read off the lockfile', async (t) => {
  for (const [lockfile, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']]) {
    const root = await fakeProject(t, { lockfile });
    assert.equal(await detectPackageManager(root), manager);
  }
  const bare = await temporaryDirectory(t);
  assert.equal(await detectPackageManager(bare), 'npm', 'npm is the fallback');
});

test('each package manager gets its own add-a-dev-dependency argv', () => {
  assert.deepEqual(installArgs('npm'), ['install', '--save-dev', PROFILER_PACKAGE]);
  assert.deepEqual(installArgs('yarn'), ['add', '--dev', PROFILER_PACKAGE]);
  assert.deepEqual(installArgs('pnpm'), ['add', '--save-dev', PROFILER_PACKAGE]);
  assert.deepEqual(installArgs('bun'), ['add', '--dev', PROFILER_PACKAGE]);
});

test('the apk is located from the metadata the Android Gradle plugin writes', async (t) => {
  const root = await fakeProject(t);
  const { applicationId, apkPath } = await readApkMetadata(join(root, 'android'), 'release');
  assert.equal(applicationId, 'com.spikeapp');
  assert.match(apkPath, /outputs\/apk\/release\/app-release\.apk$/);
});

test('missing or incomplete apk metadata is reported against its path', async (t) => {
  const root = await temporaryDirectory(t);
  await assert.rejects(readApkMetadata(join(root, 'android'), 'release'), /left no apk metadata at/);

  const outputs = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release');
  await mkdir(outputs, { recursive: true });
  await writeFile(join(outputs, 'output-metadata.json'), '{"elements":[]}');
  await assert.rejects(readApkMetadata(join(root, 'android'), 'release'), /names no applicationId or output file/);
});

test('profile build assembles with the gate armed, installs, reverses and launches', async (t) => {
  const root = await fakeProject(t);
  const { calls, exec, execCapture } = recorder();

  const result = await profileBuild({ projectRoot: root, install: false, exec, execCapture });

  const gradle = calls.find((call) => call.command.endsWith('gradlew'));
  assert.deepEqual(gradle.args, ['assembleRelease', '-PtracesiftProfiler=true']);
  assert.equal(gradle.cwd, join(root, 'android'));

  const install = calls.find((call) => call.args.includes('install'));
  assert.equal(install.command, 'adb');
  assert.match(install.args.at(-1), /app-release\.apk$/);

  const reverse = calls.find((call) => call.args.includes('reverse'));
  assert.deepEqual(reverse.args, ['reverse', 'tcp:8089', 'tcp:8089']);

  const launch = calls.find((call) => call.args.includes('am'));
  assert.deepEqual(launch.args, ['shell', 'am', 'start', '-n', 'com.spikeapp/.MainActivity']);

  assert.equal(result.applicationId, 'com.spikeapp');
  assert.equal(result.port, 8089);
  assert.match(result.sourceMap, /sourcemaps\/react\/release\/index\.android\.bundle\.map$/);
});

test('the dev dependency is added only when it is not already there', async (t) => {
  const root = await fakeProject(t);
  const first = recorder();
  await profileBuild({ projectRoot: root, exec: first.exec, execCapture: first.execCapture });
  assert.deepEqual(first.calls[0], { command: 'npm', args: ['install', '--save-dev', PROFILER_PACKAGE], cwd: root });

  await mkdir(join(root, 'node_modules', '@callstack', 'tracesift-rn-profiler'), { recursive: true });
  const second = recorder();
  await profileBuild({ projectRoot: root, exec: second.exec, execCapture: second.execCapture });
  assert.ok(!second.calls.some((call) => call.command === 'npm'), 'an installed package is not reinstalled');
});

test('--device targets one device and --no-launch leaves the app alone', async (t) => {
  const root = await fakeProject(t, { variant: 'profiling' });
  const { calls, exec, execCapture } = recorder();

  await profileBuild({ projectRoot: root, install: false, device: 'emulator-5554', launch: false, variant: 'profiling', profilerPort: 9100, exec, execCapture });

  const gradle = calls.find((call) => call.command.endsWith('gradlew'));
  assert.deepEqual(gradle.args, ['assembleProfiling', '-PtracesiftProfiler=true']);
  for (const call of calls.filter((entry) => entry.command === 'adb')) {
    assert.deepEqual(call.args.slice(0, 2), ['-s', 'emulator-5554']);
  }
  assert.deepEqual(
    calls.find((call) => call.args.includes('reverse')).args,
    ['-s', 'emulator-5554', 'reverse', 'tcp:9100', 'tcp:9100'],
  );
  assert.ok(!calls.some((call) => call.args.includes('am')), 'nothing is launched');
});

test('a directory that is not a React Native app says so before anything runs', async (t) => {
  const bare = await temporaryDirectory(t);
  const { calls, exec, execCapture } = recorder();
  await assert.rejects(profileBuild({ projectRoot: bare, exec, execCapture }), /no package.json/);

  await writeFile(join(bare, 'package.json'), '{}');
  await assert.rejects(profileBuild({ projectRoot: bare, exec, execCapture }), /no android\/gradlew/);
  assert.deepEqual(calls, [], 'nothing was run');
});

test('iOS is refused with the route that does work there', async (t) => {
  const root = await fakeProject(t);
  await assert.rejects(profileBuild({ projectRoot: root, platform: 'ios' }), /supports --platform android/);
});

test('profile build refuses flags it would ignore', () => {
  const known = ['url', 'variant', 'device', 'headless', 'metro'];
  assert.throws(() => assertProfileOptions('build', { url: 'x' }, known), /--url is not supported by tracesift profile build/);
  assert.throws(() => assertProfileOptions('build', { metro: 'x' }, known), /--metro is not supported/);
  assert.doesNotThrow(() => assertProfileOptions('build', { variant: 'release', device: 'x' }, known));
});

test('the source map path follows the variant', () => {
  assert.match(sourceMapPathFor('/a', 'release'), /sourcemaps\/react\/release\/index\.android\.bundle\.map$/);
  assert.match(sourceMapPathFor('/a', 'profiling'), /sourcemaps\/react\/profiling\//);
});
