import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assembleTask, assertProfileOptions, detectPackageManager, installArgs,
  profileBuild, readApkMetadata, sourceMapPathFor, PROFILER_PACKAGE,
  findBuiltApp, findWorkspace, iosConfiguration, iosSourceMapPath,
  listPhysicalIosDevices, matchPhysicalDevice, profileDevices, signingIdentityFrom,
  hermesFlagsDropSourceMap, androidBundlePathsFor, mapIsStale, failureDetail,
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

test('Android: a build that wrote no source map fails before anything is installed', async (t) => {
  const root = await fakeProject(t, { sourceMap: false });
  const { calls, exec, execCapture } = recorder();

  await assert.rejects(
    profileBuild({ projectRoot: root, install: false, exec, execCapture }),
    /produced no source map at .*index\.android\.bundle\.map.*output-source-map/s,
  );
  assert.ok(calls.some((call) => call.command.endsWith('gradlew')));
  assert.ok(!calls.some((call) => call.args.includes('install')), 'nothing may be installed from a build that cannot be symbolicated');
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

test('an unknown platform is refused', async (t) => {
  const root = await fakeProject(t);
  await assert.rejects(profileBuild({ projectRoot: root, platform: 'web' }), /supports --platform android or ios/);
});

/** An iOS project just real enough: Podfile, workspace, a built simulator app. */
async function fakeIosProject(t, { linked = true, sourceMap = true } = {}) {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, 'package.json'), '{"name":"spike"}');
  await writeFile(join(root, 'package-lock.json'), '');
  const ios = join(root, 'ios');
  await mkdir(join(ios, 'Spike.xcworkspace'), { recursive: true });
  await writeFile(join(ios, 'Podfile'), '');
  await writeFile(join(ios, 'Podfile.lock'), linked ? 'PODS:\n  - TracesiftProfiler (0.1.0)\n' : 'PODS:\n');
  await mkdir(join(ios, 'build', 'tracesift', 'Build', 'Products', 'Release-iphonesimulator', 'Spike.app'), { recursive: true });
  await mkdir(join(root, 'node_modules', '@callstack', 'tracesift-rn-profiler'), { recursive: true });
  if (sourceMap) await writeFile(iosSourceMapPath(ios), '{}');
  return root;
}

test('iOS: builds for the simulator, arms the built app only, installs and launches', async (t) => {
  const root = await fakeIosProject(t);
  const { calls, exec } = recorder();
  const result = await profileBuild({
    projectRoot: root, platform: 'ios', exec, execCapture: async () => 'com.spikeapp\n',
  });

  const names = calls.map((call) => `${call.command} ${call.args[0]}`);
  assert.deepEqual(names, [
    'xcodebuild -workspace', 'plutil -replace', 'plutil -replace', 'codesign --force',
    'xcrun simctl', 'xcrun simctl',
  ]);
  const build = calls[0];
  assert.ok(build.args.includes('iphonesimulator'));
  assert.ok(build.args.includes(`SOURCEMAP_FILE=${iosSourceMapPath(join(root, 'ios'))}`));
  assert.deepEqual(build.args.slice(build.args.indexOf('-scheme'), build.args.indexOf('-scheme') + 4), ['-scheme', 'Spike', '-configuration', 'Release']);

  assert.deepEqual(calls[1].args.slice(0, 4), ['-replace', 'TracesiftProfilingEnabled', '-bool', 'true']);
  assert.match(calls[1].args.at(-1), /Spike\.app\/Info\.plist$/);
  assert.deepEqual(calls[2].args.slice(0, 4), ['-replace', 'TracesiftProfilerPort', '-integer', '8089']);
  assert.deepEqual(calls[4].args.slice(0, 3), ['simctl', 'install', 'booted']);
  assert.deepEqual(calls[5].args, ['simctl', 'launch', '--terminate-running-process', 'booted', 'com.spikeapp']);
  assert.ok(!calls.some((call) => call.args.includes('Podfile')), 'the Podfile is never edited');

  assert.equal(result.applicationId, 'com.spikeapp');
  assert.match(result.sourceMap, /ios\/build\/tracesift\/main\.jsbundle\.map$/);
});

test('iOS: pod install runs only while the pod is not linked, and --device/--no-launch are honoured', async (t) => {
  const root = await fakeIosProject(t, { linked: false, sourceMap: false });
  const { calls, exec } = recorder();
  const result = await profileBuild({
    projectRoot: root, platform: 'ios', device: 'UDID-1', launch: false, profilerPort: 9100,
    exec, execCapture: async () => 'com.spikeapp\n',
  });
  assert.deepEqual(calls[0], { command: 'pod', args: ['install'], cwd: join(root, 'ios') });
  assert.deepEqual(calls.find((call) => call.args[1] === 'install').args.slice(0, 3), ['simctl', 'install', 'UDID-1']);
  assert.ok(!calls.some((call) => call.args[1] === 'launch'));
  assert.ok(calls.some((call) => call.args.includes('9100')));
  assert.equal(result.sourceMap, null);
});

test('iOS: a directory without an ios/Podfile says so before anything runs', async (t) => {
  const bare = await temporaryDirectory(t);
  await writeFile(join(bare, 'package.json'), '{}');
  const { calls, exec, execCapture } = recorder();
  await assert.rejects(profileBuild({ projectRoot: bare, platform: 'ios', exec, execCapture }), /no ios\/Podfile/);
  assert.deepEqual(calls, []);
});

test('iOS helpers: configuration, workspace and app discovery', async (t) => {
  assert.equal(iosConfiguration('release'), 'Release');
  assert.equal(iosConfiguration('Staging'), 'Staging');
  assert.throws(() => iosConfiguration('a b'), /must be an Xcode configuration name/);
  const root = await fakeIosProject(t);
  assert.deepEqual(await findWorkspace(join(root, 'ios')), { workspace: join(root, 'ios', 'Spike.xcworkspace'), scheme: 'Spike' });
  const products = join(root, 'ios', 'build', 'tracesift', 'Build', 'Products', 'Release-iphonesimulator');
  assert.equal(await findBuiltApp(products, 'Spike'), join(products, 'Spike.app'));
  await assert.rejects(findBuiltApp(join(root, 'nope'), 'Spike'), /left no products/);
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

const PHONE = {
  identifier: 'CORE-1',
  properties: {
    hardware: { udid: '00008150-AAAA', platform: 'iOS', reality: 'physical' },
    device: { name: "Hur's iPhone" },
    connection: { transportType: 'wired', pairingState: 'paired', state: 'connected', tunnelIPAddressString: 'fd00::1' },
  },
};
const SIMULATOR = {
  identifier: 'SIM-1',
  properties: { hardware: { udid: 'SIM-1', platform: 'iOS', reality: 'simulated' }, device: { name: 'iPhone 16' }, connection: {} },
};
const devicectlJson = (...devices) => JSON.stringify({ result: { devices } });

/** An execCapture that answers devicectl, codesign and plutil the way a device build does. */
function deviceCapture({ devices = [PHONE, SIMULATOR], authority = 'Authority=Apple Development: Hur Ali (TEAM)\nAuthority=Apple Worldwide Developer Relations\n' } = {}) {
  return async (command, args) => {
    if (args.includes('devicectl')) return devicectlJson(...devices);
    if (command === 'codesign') return authority;
    return 'com.spikeapp\n';
  };
}

async function fakeDeviceProject(t, { team = 'PROJTEAM01' } = {}) {
  const root = await fakeIosProject(t);
  await mkdir(join(root, 'ios', 'build', 'tracesift', 'Build', 'Products', 'Release-iphoneos', 'Spike.app'), { recursive: true });
  // A project that signs itself, as an app not made by `expo prebuild` does.
  await mkdir(join(root, 'ios', 'Spike.xcodeproj'), { recursive: true });
  await writeFile(join(root, 'ios', 'Spike.xcodeproj', 'project.pbxproj'), team ? `\t\t\t\tDEVELOPMENT_TEAM = ${team};\n` : '\t\t\t\tDEVELOPMENT_TEAM = "";\n');
  return root;
}

test('iOS device listing keeps physical devices and reads their udid, name and transport', async () => {
  const devices = await listPhysicalIosDevices(async () => devicectlJson(PHONE, SIMULATOR));
  assert.deepEqual(devices, [{ id: 'CORE-1', udid: '00008150-AAAA', name: "Hur's iPhone", platform: 'iOS', wired: true, available: true, tunnelAddress: 'fd00::1' }]);
  assert.deepEqual(await listPhysicalIosDevices(async () => { throw new Error('devicectl missing'); }), []);
  assert.deepEqual(await listPhysicalIosDevices(async () => 'not json'), []);
});

test('--device matches a udid, a CoreDevice id or an unambiguous name', () => {
  const [phone] = [{ id: 'CORE-1', udid: 'U1', name: 'A' }];
  const twin = { id: 'CORE-2', udid: 'U2', name: 'A' };
  assert.equal(matchPhysicalDevice([phone], 'U1'), phone);
  assert.equal(matchPhysicalDevice([phone], 'CORE-1'), phone);
  assert.equal(matchPhysicalDevice([phone], 'A'), phone);
  assert.equal(matchPhysicalDevice([phone], 'SIM'), null, 'anything else is left to simctl');
  assert.equal(matchPhysicalDevice([phone], undefined), null);
  assert.throws(() => matchPhysicalDevice([phone, twin], 'A'), /2 devices are named "A"[\s\S]*U1[\s\S]*U2/);
});

test('the signing identity is the leaf Authority of the built app', () => {
  assert.equal(signingIdentityFrom('Authority=Apple Development: Hur (T)\nAuthority=Apple Worldwide\n'), 'Apple Development: Hur (T)');
  assert.equal(signingIdentityFrom('Signature=adhoc\n'), null);
});

test('iOS device: builds for iphoneos, re-signs with the real identity, installs and launches with devicectl', async (t) => {
  const root = await fakeDeviceProject(t);
  const { calls, exec } = recorder();
  const result = await profileBuild({ projectRoot: root, platform: 'ios', device: '00008150-AAAA', exec, execCapture: deviceCapture() });

  assert.deepEqual(calls.map((call) => `${call.command} ${call.args[0]}`), [
    'xcodebuild -workspace', 'plutil -replace', 'plutil -replace', 'plutil -replace', 'codesign --force',
    'xcrun devicectl', 'xcrun devicectl',
  ]);
  const build = calls[0].args;
  assert.equal(build[build.indexOf('-sdk') + 1], 'iphoneos');
  assert.equal(build[build.indexOf('-destination') + 1], 'generic/platform=iOS');
  assert.ok(build.includes('-allowProvisioningUpdates'));
  assert.deepEqual(calls[3].args.slice(0, 4), ['-replace', 'TracesiftProfilerTransport', '-string', 'listen']);
  assert.deepEqual(calls[4].args.slice(0, 4), ['--force', '--sign', 'Apple Development: Hur Ali (TEAM)', '--preserve-metadata=identifier,entitlements,flags']);
  assert.match(calls[4].args.at(-1), /Release-iphoneos\/Spike\.app$/);
  assert.deepEqual(calls[5].args.slice(0, 5), ['devicectl', 'device', 'install', 'app', '--device']);
  assert.equal(calls[5].args[5], '00008150-AAAA');
  assert.deepEqual(calls[6].args, ['devicectl', 'device', 'process', 'launch', '--device', '00008150-AAAA', '--terminate-existing', 'com.spikeapp']);
  assert.ok(!calls.some((call) => call.args.includes('-')), 'no ad-hoc signature');
  assert.equal(result.target, 'device');
});

test('iOS device: an unsigned build stops before install with a pointer to the fix', async (t) => {
  const root = await fakeDeviceProject(t);
  const { calls, exec } = recorder();
  await assert.rejects(
    profileBuild({ projectRoot: root, platform: 'ios', device: 'CORE-1', exec, execCapture: deviceCapture({ authority: 'Signature=adhoc\n' }) }),
    /not code signed[\s\S]*development team/,
  );
  assert.ok(!calls.some((call) => call.args.includes('install')), 'nothing was installed');
});

test('iOS device: the team is taken from the profile that covers the phone', async (t) => {
  const root = await fakeDeviceProject(t);
  const { calls, exec } = recorder();
  const detectTeam = async (udid) => { seen.push(udid); return { teamId: '256PKG3W2C', teamName: 'Hur Ali' }; };
  const seen = [];
  await profileBuild({ projectRoot: root, platform: 'ios', device: '00008150-AAAA', exec, execCapture: deviceCapture(), detectTeam });

  assert.deepEqual(seen, ['00008150-AAAA'], 'the phone decides the team');
  assert.ok(calls[0].args.includes('DEVELOPMENT_TEAM=256PKG3W2C'));
});

test('iOS device: --team wins over the profiles, and is not looked up', async (t) => {
  const root = await fakeDeviceProject(t);
  const { calls, exec } = recorder();
  let looked = false;
  await profileBuild({
    projectRoot: root, platform: 'ios', device: '00008150-AAAA', team: 'PJL7DA2X5F',
    exec, execCapture: deviceCapture(), detectTeam: async () => { looked = true; return { teamId: '256PKG3W2C', teamName: 'Hur Ali' }; },
  });

  assert.equal(looked, false);
  assert.ok(calls[0].args.includes('DEVELOPMENT_TEAM=PJL7DA2X5F'));
});

test('iOS device: a project that names its own team is left alone', async (t) => {
  const root = await fakeDeviceProject(t);
  const { calls, exec } = recorder();
  await profileBuild({ projectRoot: root, platform: 'ios', device: '00008150-AAAA', exec, execCapture: deviceCapture(), detectTeam: async () => null });

  assert.ok(!calls[0].args.some((arg) => String(arg).startsWith('DEVELOPMENT_TEAM=')));
});

test('iOS device: nothing to sign with stops before the build, naming the phone', async (t) => {
  const root = await fakeDeviceProject(t, { team: null });
  const { calls, exec } = recorder();

  await assert.rejects(
    profileBuild({
      projectRoot: root, platform: 'ios', device: '00008150-AAAA', exec, execCapture: deviceCapture(),
      detectTeam: async () => null, deviceProfiles: async () => ({ current: [], expired: [] }),
    }),
    /No provisioning profile on this Mac covers Hur's iPhone \(00008150-AAAA\)[\s\S]*--team/,
  );
  assert.equal(calls.length, 0, 'nothing is built');
});

test('iOS device: profiles that have only lapsed say so, with the date', async (t) => {
  const root = await fakeDeviceProject(t, { team: null });
  const { calls, exec } = recorder();

  await assert.rejects(
    profileBuild({
      projectRoot: root, platform: 'ios', device: '00008150-AAAA', exec, execCapture: deviceCapture(),
      detectTeam: async () => null,
      deviceProfiles: async () => ({ current: [], expired: [{ teamId: '256PKG3W2C', teamName: 'Hur Ali', expires: new Date('2026-11-30T10:21:30Z') }] }),
    }),
    /have expired: 256PKG3W2C \(Hur Ali\), expired 2026-11-30[\s\S]*seven days/,
  );
  assert.equal(calls.length, 0, 'nothing is built');
});

test('iOS simulator: no team is looked up, since an ad-hoc signature installs', async (t) => {
  const root = await fakeIosProject(t);
  const { exec } = recorder();
  let looked = false;
  await profileBuild({
    projectRoot: root, platform: 'ios', exec, execCapture: async () => 'com.spikeapp\n',
    detectTeam: async () => { looked = true; return null; },
  });
  assert.equal(looked, false);
});

test('iOS: a --device that is not a physical device still goes to the simulator', async (t) => {
  const root = await fakeIosProject(t);
  const { calls, exec } = recorder();
  const result = await profileBuild({ projectRoot: root, platform: 'ios', device: 'SIM-1', exec, execCapture: deviceCapture() });
  assert.ok(calls[0].args.includes('iphonesimulator'));
  assert.ok(!calls.some((call) => call.args.includes('listen')), 'the simulator is never switched to the listen transport');
  assert.deepEqual(calls.at(-2).args.slice(0, 3), ['simctl', 'install', 'SIM-1']);
  assert.equal(result.target, 'simulator');
});

test('profile devices lists physical devices with their transport, then booted simulators', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (line) => logs.push(line));
  const rows = await profileDevices({
    execCapture: async (command, args) => args.includes('devicectl')
      ? devicectlJson(PHONE)
      : JSON.stringify({ devices: { 'iOS-26': [{ udid: 'SIM-1', name: 'iPhone 16' }] } }),
  });
  assert.deepEqual(rows.map((row) => [row.kind, row.id, row.note]), [['device', '00008150-AAAA', 'USB, tunnel up'], ['simulator', 'SIM-1', 'booted']]);
  assert.equal(logs.length, 2);
});

const DAY = 24 * 60 * 60 * 1000;
async function age(path, msAgo) {
  const when = new Date(Date.now() - msAgo);
  await utimes(path, when, when);
}
async function writeGradle(root, body) {
  await mkdir(join(root, 'android', 'app'), { recursive: true });
  await writeFile(join(root, 'android', 'app', 'build.gradle'), body);
}

test('hermesFlags: only an explicit literal without -output-source-map is a verdict', () => {
  const drops = (text) => hermesFlagsDropSourceMap(text).dropsSourceMap;
  assert.equal(drops('react {\n  hermesFlags = ["-O"]\n}'), true);
  assert.equal(drops("react { hermesFlags = [] }"), true);
  assert.equal(drops("react { hermesFlags = '-O' }"), true);
  assert.equal(drops('react { hermesFlags.set(["-O"]) }'), true);
  // Not concluded: absent (RN default keeps the flag), keeps the flag, or needs evaluating.
  assert.equal(drops('react {\n  // hermesFlags = ["-O"]\n}'), false, 'a comment is not an assignment');
  assert.equal(drops('android { }'), false, 'absence must not fail the build');
  assert.equal(drops('react { hermesFlags = ["-O", "-output-source-map"] }'), false);
  assert.equal(drops('react { hermesFlags = baseFlags }'), false);
  assert.equal(drops('react { hermesFlags = ["-O"] + extraFlags }'), false);
  assert.equal(drops('react { hermesFlags = flags() }'), false);
  assert.equal(drops('react { hermesFlags = ["-O"] }\nreact { hermesFlags = ["-output-source-map"] }'), false, 'any assignment keeping it is enough doubt');
});

test('Android: hermesFlags without -output-source-map fails before Gradle runs', async (t) => {
  const root = await fakeProject(t);
  await writeGradle(root, 'react {\n  hermesFlags = ["-O"]\n}\n');
  const { calls, exec, execCapture } = recorder();
  await assert.rejects(
    profileBuild({ projectRoot: root, install: false, exec, execCapture }),
    /hermesFlags \("-O"\) without "-output-source-map"/,
  );
  assert.deepEqual(calls, [], 'no Gradle build was paid for');
});

test('Android: a build.gradle with no hermesFlags, or one keeping the flag, builds normally', async (t) => {
  for (const body of ['react {\n}\n', 'react { hermesFlags = ["-O", "-output-source-map"] }']) {
    const root = await fakeProject(t);
    await writeGradle(root, body);
    const { calls, exec, execCapture } = recorder();
    await profileBuild({ projectRoot: root, install: false, exec, execCapture });
    assert.ok(calls.some((call) => call.command.endsWith('gradlew')));
  }
});

test('mapIsStale compares against the artefact, with a tolerance, and ignores missing files', async (t) => {
  const dir = await temporaryDirectory(t);
  const map = join(dir, 'a.map');
  const bundle = join(dir, 'a.bundle');
  await writeFile(map, '{}');
  await writeFile(bundle, '');
  assert.equal(await mapIsStale(map, bundle), null, 'same age is fresh');
  await age(map, 30 * 1000);
  assert.equal(await mapIsStale(map, bundle), null, 'seconds apart is within tolerance');
  await age(map, 11 * DAY);
  assert.ok(await mapIsStale(map, bundle), 'eleven days older is stale');
  assert.equal(await mapIsStale(join(dir, 'missing.map'), bundle), null);
});

test('Android: a map older than the build it describes warns but still installs', async (t) => {
  const root = await fakeProject(t);
  const android = join(root, 'android');
  const [bundle] = androidBundlePathsFor(android, 'release');
  await mkdir(join(bundle, '..'), { recursive: true });
  await writeFile(bundle, '');
  await age(sourceMapPathFor(android, 'release'), 11 * DAY);

  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const { calls, exec, execCapture } = recorder();
  const result = await profileBuild({ projectRoot: root, install: false, exec, execCapture });

  assert.equal(result.staleMap, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /older than the build it should describe/);
  assert.ok(calls.some((call) => call.args.includes('install')), 'a warning, not a failure');
});

test('Android: a fresh map does not warn', async (t) => {
  const root = await fakeProject(t);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const { exec, execCapture } = recorder();
  const result = await profileBuild({ projectRoot: root, install: false, exec, execCapture });
  assert.equal(result.staleMap, false);
  assert.deepEqual(warnings, []);
});

async function addIosBundle(root) {
  const bundle = join(root, 'ios', 'build', 'tracesift', 'Build', 'Products', 'Release-iphonesimulator', 'Spike.app', 'main.jsbundle');
  await writeFile(bundle, '');
  return bundle;
}

test('iOS: a map older than the built bundle warns', async (t) => {
  const root = await fakeIosProject(t);
  await addIosBundle(root);
  await age(iosSourceMapPath(join(root, 'ios')), 11 * DAY);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const { exec } = recorder();
  const result = await profileBuild({ projectRoot: root, platform: 'ios', exec, execCapture: async () => 'com.spikeapp\n' });
  assert.equal(result.staleMap, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /main\.jsbundle\.map/);
});

test('iOS: a fresh Expo root map is preferred over a stale build-directory one', async (t) => {
  const root = await fakeIosProject(t);
  await addIosBundle(root);
  await age(iosSourceMapPath(join(root, 'ios')), 11 * DAY);
  await writeFile(join(root, 'main.jsbundle.map'), '{}');
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const { exec } = recorder();
  const result = await profileBuild({ projectRoot: root, platform: 'ios', exec, execCapture: async () => 'com.spikeapp\n' });
  assert.equal(result.sourceMap, join(root, 'main.jsbundle.map'));
  assert.equal(result.staleMap, false);
  assert.deepEqual(warnings, []);
});

test('iOS: a stale Expo root map alone warns too', async (t) => {
  const root = await fakeIosProject(t, { sourceMap: false });
  await addIosBundle(root);
  await writeFile(join(root, 'main.jsbundle.map'), '{}');
  await age(join(root, 'main.jsbundle.map'), 11 * DAY);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const { exec } = recorder();
  const result = await profileBuild({ projectRoot: root, platform: 'ios', exec, execCapture: async () => 'com.spikeapp\n' });
  assert.equal(result.staleMap, true);
  assert.match(warnings[0], /root|main\.jsbundle\.map/);
});

test('a failed build repeats the reason Gradle gave, not just its exit code', () => {
  const detail = failureDetail([
    '> Task :app:compileReleaseKotlin',
    'FAILURE: Build failed with an exception.',
    '',
    '* What went wrong:',
    'A problem occurred evaluating project \':app\'.',
    '> Cannot run program "node": error=2, No such file or directory',
    '',
    '* Try:',
    '> Run with --stacktrace option to get the stack trace.',
  ].join('\n'));
  assert.equal(detail, '\nA problem occurred evaluating project \':app\'.\n> Cannot run program "node": error=2, No such file or directory');
});

test('a build that failed without a summary still says the last of what it printed', () => {
  assert.match(failureDetail('one\ntwo\nninja: build stopped.'), /ninja: build stopped\./);
  assert.equal(failureDetail(''), '');
  assert.equal(failureDetail(undefined), '');
});
