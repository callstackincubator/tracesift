// `tracesift profile build` — turn an app into a profiling build and get it onto the device,
// without the developer editing anything.
import { spawn } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildEnv, listAndroidDevices, resolveAdb } from './android-devices.js';
import { capture, listPhysicalIosDevices, matchPhysicalDevice } from './ios-devices.js';
import { detectDevelopmentTeam, profilesForDevice, projectDevelopmentTeam } from './ios-teams.js';
import { DEFAULT_PROFILER_PORT } from './rn-profiler-link.js';

export { listPhysicalIosDevices, matchPhysicalDevice };

export const PROFILER_PACKAGE = '@callstack/tracesift-rn-profiler';
/** The Gradle property the library's manifest placeholder reads. */
export const PROFILER_GRADLE_PROPERTY = 'tracesiftProfiler';

export const PROFILE_SUBCOMMANDS = ['build', 'devices'];

/** Which options each `profile` subcommand understands. */
const PROFILE_OPTIONS = {
  build: ['platform', 'variant', 'device', 'profiler-port', 'no-install', 'no-launch', 'team'],
  devices: [],
};

/** Reject an option `profile` would silently ignore, the way `record` does: a flag that looks
 * honoured but is not is worse than one that is refused. */
export function assertProfileOptions(subcommand, values, allKnownOptions) {
  const allowed = PROFILE_OPTIONS[subcommand] ?? [];
  const given = allKnownOptions.filter((option) => values[option]);
  const rejected = given.find((option) => !allowed.includes(option));
  if (rejected) throw new Error(`--${rejected} is not supported by tracesift profile ${subcommand}. Run tracesift --help.`);
}

/** `release` -> `assembleRelease`. */
export function assembleTask(variant) {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(variant)) {
    throw new Error('--variant must be a Gradle variant name such as release or profiling.');
  }
  return `assemble${variant[0].toUpperCase()}${variant.slice(1)}`;
}

/** Which package manager the project uses. */
export async function detectPackageManager(root) {
  const lockfiles = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [lockfile, manager] of lockfiles) {
    if (await exists(join(root, lockfile))) return manager;
  }
  return 'npm';
}

/** The argv that adds the profiler as a dev dependency. */
export function installArgs(manager) {
  switch (manager) {
    case 'yarn': return ['add', '--dev', PROFILER_PACKAGE];
    case 'pnpm': return ['add', '--save-dev', PROFILER_PACKAGE];
    case 'bun': return ['add', '--dev', PROFILER_PACKAGE];
    default: return ['install', '--save-dev', PROFILER_PACKAGE];
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read the applicationId and apk filename out of the metadata the Android Gradle plugin writes
 * beside the build. */
export async function readApkMetadata(androidRoot, variant) {
  const path = join(androidRoot, 'app', 'build', 'outputs', 'apk', variant, 'output-metadata.json');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`The build finished but left no apk metadata at ${path}: ${error.message}`);
  }
  const element = parsed.elements?.[0];
  if (!parsed.applicationId || !element?.outputFile) {
    throw new Error(`The apk metadata at ${path} names no applicationId or output file.`);
  }
  return {
    applicationId: parsed.applicationId,
    apkPath: join(androidRoot, 'app', 'build', 'outputs', 'apk', variant, element.outputFile),
  };
}

/** The Info.plist key that arms the iOS profiler. Absent by default. */
export const PROFILER_PLIST_KEY = 'TracesiftProfilingEnabled';
export const PROFILER_PLIST_PORT_KEY = 'TracesiftProfilerPort';
/** "listen" on physical devices: the app serves on its CoreDevice tunnel address and the CLI dials in. */
export const PROFILER_PLIST_TRANSPORT_KEY = 'TracesiftProfilerTransport';
/** Where `profile build --platform ios` builds and writes the source map, under ios/. */
export const IOS_BUILD_DIRECTORY = join('build', 'tracesift');

/** `release` -> `Release`, the Xcode configuration name. */
export function iosConfiguration(variant) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(variant)) {
    throw new Error('--variant must be an Xcode configuration name such as release or profiling.');
  }
  return `${variant[0].toUpperCase()}${variant.slice(1)}`;
}

/** Stop before a device build that cannot be signed, saying which of the two reasons it is. */
async function assertDeviceCanBeSigned(physical, iosRoot, options = {}) {
  if (await (options.projectTeam ?? projectDevelopmentTeam)(iosRoot)) return;
  const { expired } = await (options.deviceProfiles ?? profilesForDevice)(physical.udid);
  const where = `${physical.name} (${physical.udid})`;
  if (expired.length) {
    const lapsed = expired
      .map((team) => `${team.teamId} (${team.teamName}), expired ${team.expires.toISOString().slice(0, 10)}`)
      .join('; ');
    throw new Error(
      `The only provisioning profiles covering ${where} have expired: ${lapsed}. A free Personal Team's profiles last seven days. `
      + 'Open the project in Xcode once to renew them, or pass --team <id> so xcodebuild fetches a new one.',
    );
  }
  throw new Error(
    `No provisioning profile on this Mac covers ${where}, and the Xcode project sets no DEVELOPMENT_TEAM, so the build could not be signed. `
    + 'Pass --team <id> (Xcode > Settings > Accounts shows your Team ID), or open the project in Xcode once and pick a team under Signing & Capabilities.',
  );
}

/** Where the Xcode bundle phase is told to write the source map (SOURCEMAP_FILE). */
export function iosSourceMapPath(iosRoot) {
  return join(iosRoot, IOS_BUILD_DIRECTORY, 'main.jsbundle.map');
}

/** The first .xcworkspace in ios/, which is also the scheme name CocoaPods gives the app. */
export async function findWorkspace(iosRoot) {
  let entries;
  try {
    entries = await readdir(iosRoot);
  } catch {
    entries = [];
  }
  const workspace = entries.filter((entry) => entry.endsWith('.xcworkspace')).sort()[0];
  if (!workspace) {
    throw new Error(`There is no .xcworkspace in ${iosRoot}. Run pod install there, or run this from the root of a React Native app.`);
  }
  return { workspace: join(iosRoot, workspace), scheme: workspace.slice(0, -'.xcworkspace'.length) };
}

/** The built .app, preferring the one named for the scheme. */
export async function findBuiltApp(productsDirectory, scheme) {
  let entries;
  try {
    entries = (await readdir(productsDirectory)).filter((entry) => entry.endsWith('.app'));
  } catch (error) {
    throw new Error(`The build finished but left no products at ${productsDirectory}: ${error.message}`);
  }
  const app = entries.find((entry) => entry === `${scheme}.app`) ?? entries[0];
  if (!app) throw new Error(`The build finished but left no .app in ${productsDirectory}.`);
  return join(productsDirectory, app);
}


/** The Apple Development / Distribution identity a built app was signed with. */
export function signingIdentityFrom(codesignOutput) {
  const authority = /^Authority=(.+)$/m.exec(codesignOutput);
  return authority ? authority[1].trim() : null;
}

/** `tracesift profile devices`: what `profile build --device` accepts. */
export async function profileDevices(options = {}) {
  const execCapture = options.execCapture ?? capture;
  const devices = await listPhysicalIosDevices(execCapture);
  let simulators = [];
  try {
    const booted = JSON.parse(await execCapture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']));
    simulators = Object.values(booted.devices ?? {}).flat().map((entry) => ({ id: entry.udid, name: entry.name }));
  } catch {
    // No simulators is a fine answer.
  }
  const rows = [
    ...devices.map((device) => ({ kind: 'device', id: device.udid, name: device.name, note: device.tunnelAddress ? 'USB, tunnel up' : device.wired ? 'USB, tunnel down — unlock it' : 'not on USB — attach it with a cable' })),
    ...simulators.map((simulator) => ({ kind: 'simulator', id: simulator.id, name: simulator.name, note: 'booted' })),
    // Android belongs in the same listing: the panel offers one list of places
    // a profiling build can go, and a phone the developer has plugged in
    // should appear there by name whichever platform it is.
    ...await listAndroidDevices(execCapture),
  ];
  if (rows.length === 0) console.log('No iOS or Android devices, emulators or booted simulators found.');
  for (const row of rows) console.log(`${row.kind.padEnd(10)} ${row.id}  ${row.name}  (${row.note})`);
  return rows;
}

/** Build, arm, install and launch a profiling build in the iOS simulator or on a wired iPhone. */
async function profileBuildIos(options) {
  const exec = options.exec ?? run;
  const execCapture = options.execCapture ?? capture;
  const root = resolve(options.projectRoot ?? process.cwd());
  const iosRoot = join(root, 'ios');
  const configuration = iosConfiguration(options.variant ?? 'release');
  const port = options.profilerPort ?? DEFAULT_PROFILER_PORT;
  let device = options.device ?? 'booted';

  if (!await exists(join(root, 'package.json'))) {
    throw new Error(`There is no package.json in ${root}. Run this from the root of a React Native app.`);
  }
  if (!await exists(join(iosRoot, 'Podfile'))) {
    throw new Error(`There is no ios/Podfile in ${root}. Run this from the root of a React Native app.`);
  }

  let installed = await exists(join(root, 'node_modules', ...PROFILER_PACKAGE.split('/')));
  if (options.install !== false && !installed) {
    const manager = await detectPackageManager(root);
    console.log(`Adding ${PROFILER_PACKAGE} as a dev dependency with ${manager}.`);
    await exec(manager, installArgs(manager), { cwd: root });
    installed = true;
  }

  // Autolinking only picks the pod up on the next pod install. Re-running it
  // edits Podfile.lock and Pods/, never the Podfile.
  const lockfile = join(iosRoot, 'Podfile.lock');
  const linked = await exists(lockfile) && (await readFile(lockfile, 'utf8')).includes('TracesiftProfiler');
  if (installed && !linked) {
    console.log('Linking the profiler pod (pod install).');
    // CocoaPods crashes on a non-UTF-8 locale, which a GUI-launched or CI shell often has.
    const utf8 = /utf-?8/i.test(process.env.LC_ALL ?? process.env.LANG ?? '');
    await exec('pod', ['install'], { cwd: iosRoot, ...(utf8 ? {} : { env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } }) });
  }

  // The target decides the SDK. Without --device it is the booted simulator, as
  // it always was; with one, a physical match wins and anything else is
  // handed to simctl, which rejects what it does not know.
  const physical = options.device ? matchPhysicalDevice(await listPhysicalIosDevices(execCapture), options.device) : null;
  if (physical) {
    device = physical.udid;
    if (!physical.available) throw new Error(`${physical.name} is not paired. Unlock it, tap Trust, and enable Developer Mode.`);
    if (!physical.tunnelAddress) {
      console.log(`${physical.name} has no CoreDevice tunnel up (it needs a cable and to be unlocked). Recording reaches the app through that tunnel, so it will not find it until the tunnel is up.`);
    }
  }
  const sdk = physical ? 'iphoneos' : 'iphonesimulator';

  // A device build has to be signed, and `expo prebuild` leaves no DEVELOPMENT_TEAM in the project,
  // so without this the build fails until the developer looks their team id up.
  let team = options.team;
  if (physical && !team) {
    const detected = await (options.detectTeam ?? detectDevelopmentTeam)(physical.udid);
    if (detected) {
      team = detected.teamId;
      console.log(`Signing with team ${detected.teamId} (${detected.teamName}), from the provisioning profile that covers ${physical.name}.`);
    } else {
      // Nothing to sign with from either source. xcodebuild's own failure here
      // says only "requires a development team", which does not say that a
      // week-old Personal Team profile lapsing is the usual cause.
      await assertDeviceCanBeSigned(physical, iosRoot, options);
    }
  }

  const { workspace, scheme } = await findWorkspace(iosRoot);
  const derived = join(iosRoot, IOS_BUILD_DIRECTORY);
  const sourceMap = iosSourceMapPath(iosRoot);
  console.log(`Building ${scheme} (${configuration}) for ${physical ? physical.name : 'the simulator'}.`);
  await exec('xcodebuild', [
    '-workspace', workspace, '-scheme', scheme, '-configuration', configuration,
    '-sdk', sdk, '-destination', physical ? 'generic/platform=iOS' : 'generic/platform=iOS Simulator',
    // Lets Xcode fetch or create the provisioning profile for an automatically
    // signed project. A manually signed one keeps using what it names.
    ...(physical ? ['-allowProvisioningUpdates'] : []),
    // Only for a project with no team set; otherwise Xcode uses the project's own.
    ...(physical && team ? [`DEVELOPMENT_TEAM=${team}`] : []),
    '-derivedDataPath', derived,
    // react-native-xcode.sh reads this to write the map beside the bundle.
    `SOURCEMAP_FILE=${sourceMap}`,
  ], { cwd: iosRoot });

  const appPath = await findBuiltApp(join(derived, 'Build', 'Products', `${configuration}-${sdk}`), scheme);
  const plist = join(appPath, 'Info.plist');
  const bundleId = (await execCapture('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])).trim();
  if (!bundleId) throw new Error(`${plist} names no CFBundleIdentifier.`);

  await exec('plutil', ['-replace', PROFILER_PLIST_KEY, '-bool', 'true', plist]);
  await exec('plutil', ['-replace', PROFILER_PLIST_PORT_KEY, '-integer', String(port), plist]);
  if (physical) await exec('plutil', ['-replace', PROFILER_PLIST_TRANSPORT_KEY, '-string', 'listen', plist]);
  // Editing the plist breaks the signature. The simulator build carries an
  // ad-hoc one, so it is redone ad hoc; a device build was signed for real by
  // xcodebuild, and is re-sealed with that same identity and its entitlements.
  if (physical) {
    const details = await execCapture('codesign', ['-dvv', appPath], { includeStderr: true }).catch(() => '');
    const identity = signingIdentityFrom(details);
    if (!identity) {
      throw new Error(`${scheme} was not code signed, so it cannot be installed on a device. Set a development team for the target in Xcode (Signing & Capabilities), then run this again.`);
    }
    await exec('codesign', ['--force', '--sign', identity, '--preserve-metadata=identifier,entitlements,flags', appPath]);
  } else {
    await exec('codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', appPath]);
  }
  console.log(`Armed ${PROFILER_PLIST_KEY} in the built app only; your project is unchanged.`);

  console.log(`Installing ${bundleId}.`);
  if (physical) {
    await exec('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device, appPath]);
    if (options.launch !== false) {
      await exec('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device, '--terminate-existing', bundleId]);
      console.log(`Launched ${bundleId}. Keep the phone unlocked: the profiler starts once the app is in the foreground.`);
    }
  } else {
    await exec('xcrun', ['simctl', 'install', device, appPath]);
    if (options.launch !== false) {
      await exec('xcrun', ['simctl', 'launch', '--terminate-running-process', device, bundleId]);
      console.log(`Launched ${bundleId}.`);
    }
  }

  // Expo's bundle phase writes to the project root whatever SOURCEMAP_FILE
  // says, so that is accepted too. `record start` reads both from the app root.
  const found = [sourceMap, join(root, 'main.jsbundle.map')];
  const existing = [];
  for (const candidate of found) {
    if (await exists(candidate)) existing.push(candidate);
  }
  // The bundle the app was built with is what the map must describe; a map
  // older than it is left over. A fresh candidate wins over a stale one.
  const bundle = await exists(join(appPath, 'main.jsbundle')) ? join(appPath, 'main.jsbundle') : null;
  let foundMap = existing[0] ?? null;
  let staleMap = false;
  if (bundle) {
    const verdicts = await Promise.all(existing.map((candidate) => mapIsStale(candidate, bundle)));
    const fresh = existing.findIndex((_, index) => !verdicts[index]);
    if (existing.length > 0 && fresh === -1) {
      staleMap = true;
      warnStaleMap(existing[0], bundle, verdicts[0]);
    } else if (fresh > 0) {
      foundMap = existing[fresh];
    }
  }
  console.log('');
  console.log('Ready. Record it with:');
  console.log(`  tracesift record start --platform rn${foundMap ? '' : ' --source-map <path>'}`);
  if (!foundMap) {
    console.log(`\nNo source map at ${sourceMap}; the bundle phase did not write one. Point --source-map at the one your build produces.`);
  }
  return { applicationId: bundleId, appPath, sourceMap: foundMap, staleMap, port, target: physical ? 'device' : 'simulator' };
}

/** Where the React Native Gradle plugin writes the variant's source map. */
export function sourceMapPathFor(androidRoot, variant) {
  return join(androidRoot, 'app', 'build', 'generated', 'sourcemaps', 'react', variant, 'index.android.bundle.map');
}

const OUTPUT_SOURCE_MAP_FLAG = '-output-source-map';

/** Best-effort, text-level read of `hermesFlags` in android/app/build.gradle, done before the Gradle
 * build so a misconfigured app fails in seconds. */
export function hermesFlagsDropSourceMap(gradleText) {
  const text = gradleText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$|\s\/\/.*$/gm, '');
  const assignment = /\bhermesFlags\s*(?:=|\.set\(|\.convention\()\s*/g;
  const found = [];
  let match;
  while ((match = assignment.exec(text))) {
    const rest = text.slice(assignment.lastIndex);
    const literal = /^(?:\[([^\]]*)\]|"([^"]*)"|'([^']*)')(?!\s*[+.\[])/.exec(rest);
    if (!literal) return { dropsSourceMap: false }; // not a literal: cannot conclude
    found.push((literal[1] ?? literal[2] ?? literal[3] ?? '').trim());
  }
  if (found.length === 0) return { dropsSourceMap: false }; // absent: RN's default keeps the flag
  if (found.some((flags) => flags.includes(OUTPUT_SOURCE_MAP_FLAG))) return { dropsSourceMap: false };
  return { dropsSourceMap: true, flags: found[found.length - 1] };
}

/** Throws before Gradle runs if build.gradle explicitly sets hermesFlags without -output-source-map. */
export async function assertHermesFlagsKeepSourceMap(androidRoot) {
  let text;
  try {
    text = await readFile(join(androidRoot, 'app', 'build.gradle'), 'utf8');
  } catch {
    return; // no readable build.gradle: nothing to conclude
  }
  const verdict = hermesFlagsDropSourceMap(text);
  if (verdict.dropsSourceMap) {
    throw new Error(
      `android/app/build.gradle sets hermesFlags (${verdict.flags || 'empty'}) without "${OUTPUT_SOURCE_MAP_FLAG}", so the build would write no source map `
      + `and every frame in a profile would be a bundle offset. Add "${OUTPUT_SOURCE_MAP_FLAG}" to hermesFlags in the react {} block, or remove hermesFlags to use React Native's default.`,
    );
  }
}

/** A map should be written by the same step as the bundle it describes, so it cannot be meaningfully
 * older. */
export const STALE_MAP_TOLERANCE_MS = 2 * 60 * 1000;

/** Is `mapPath` older than `artefactPath`, the file the build just produced? */
export async function mapIsStale(mapPath, artefactPath, toleranceMs = STALE_MAP_TOLERANCE_MS) {
  try {
    const [map, artefact] = await Promise.all([stat(mapPath), stat(artefactPath)]);
    return map.mtimeMs < artefact.mtimeMs - toleranceMs ? { mapMtime: map.mtime, artefactMtime: artefact.mtime } : null;
  } catch {
    return null;
  }
}

/** Warn, never fail: an up-to-date Gradle task or a skewed clock can look stale legitimately. */
function warnStaleMap(mapPath, artefactPath, stale) {
  console.warn(
    `\nWarning: the source map ${mapPath} (${stale.mapMtime.toISOString()}) is older than the build it should describe `
    + `(${artefactPath}, ${stale.artefactMtime.toISOString()}). It may be left over from an earlier build, and frames symbolicated with it can be wrong. `
    + 'Delete it and build again if the app source changed.',
  );
}

/** Where the Android bundle (Hermes bytecode) is written, beside which the map is produced. */
export function androidBundlePathsFor(androidRoot, variant) {
  const name = `${variant[0].toUpperCase()}${variant.slice(1)}`;
  const assets = join(androidRoot, 'app', 'build', 'generated', 'assets');
  return [
    join(assets, 'react', variant, 'index.android.bundle'),
    join(assets, `createBundle${name}JsAndAssets`, 'index.android.bundle'),
  ];
}

/** Run a command, inheriting stdio so the build's own output is the output. */
function run(command, args, { keepTail = 0, ...options } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: keepTail ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...options });
    let tail = '';
    if (keepTail) {
      const mirror = (into) => (chunk) => {
        into.write(chunk);
        tail = (tail + chunk).split('\n').slice(-keepTail).join('\n');
      };
      child.stdout.on('data', mirror(process.stdout));
      child.stderr.on('data', mirror(process.stderr));
    }
    child.on('error', (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args[0] ?? ''} failed with exit code ${code}.${failureDetail(tail)}`));
    });
  });
}

/** The part of a build's output worth repeating in the error. */
export function failureDetail(tail) {
  const text = (tail ?? '').trim();
  if (!text) return '';
  const marked = text.indexOf('* What went wrong:');
  const reason = marked >= 0
    ? text.slice(marked + '* What went wrong:'.length).split('* Try:')[0]
    : text.split('\n').slice(-6).join('\n');
  const cleaned = reason.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  return cleaned ? `\n${cleaned}` : '';
}

/** Build, install and arm a profiling build. */
export async function profileBuild(options = {}) {
  const platform = options.platform ?? 'android';
  if (platform === 'ios') return profileBuildIos(options);
  if (platform !== 'android') {
    throw new Error('tracesift profile build supports --platform android or ios.');
  }

  const exec = options.exec ?? run;
  const execCapture = options.execCapture ?? capture;
  const root = resolve(options.projectRoot ?? process.cwd());
  const androidRoot = join(root, 'android');
  const variant = options.variant ?? 'release';
  const port = options.profilerPort ?? DEFAULT_PROFILER_PORT;

  if (!await exists(join(root, 'package.json'))) {
    throw new Error(`There is no package.json in ${root}. Run this from the root of a React Native app.`);
  }
  const gradlew = join(androidRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!await exists(gradlew)) {
    throw new Error(`There is no android/gradlew in ${root}. Run this from the root of a React Native app.`);
  }

  if (options.install !== false && !await exists(join(root, 'node_modules', ...PROFILER_PACKAGE.split('/')))) {
    const manager = await detectPackageManager(root);
    console.log(`Adding ${PROFILER_PACKAGE} as a dev dependency with ${manager}.`);
    await exec(manager, installArgs(manager), { cwd: root });
  }

  // Early and best effort: an explicit hermesFlags without the flag is the one
  // misconfiguration readable from text. The guard after the build stays.
  await assertHermesFlagsKeepSourceMap(androidRoot);

  const task = assembleTask(variant);
  console.log(`Building ${task} with profiling armed (-P${PROFILER_GRADLE_PROPERTY}=true).`);
  // Gradle inherits this environment, and under launchd it has no Node and no
  // platform-tools; see buildEnv.
  await exec(gradlew, [task, `-P${PROFILER_GRADLE_PROPERTY}=true`], { cwd: androidRoot, env: await buildEnv(), keepTail: 60 });

  // Checked before anything is installed.
  const sourceMap = sourceMapPathFor(androidRoot, variant);
  if (!await exists(sourceMap)) {
    throw new Error(
      `${task} produced no source map at ${sourceMap}. Without it every frame in a profile is a bundle offset. `
      + 'Make sure android/app/build.gradle does not drop "-output-source-map" from hermesFlags in its react {} block, then build again.',
    );
  }

  const { applicationId, apkPath } = await readApkMetadata(androidRoot, variant);

  // The map's sibling bundle is the better reference; the apk stands in for it.
  let reference = apkPath;
  for (const candidate of androidBundlePathsFor(androidRoot, variant)) {
    if (await exists(candidate)) { reference = candidate; break; }
  }
  const stale = await mapIsStale(sourceMap, reference);
  if (stale) warnStaleMap(sourceMap, reference, stale);

  // Not plain `adb`: started by the desktop app we have launchd's PATH, which
  // has no platform-tools on it.
  const adb = [await resolveAdb(), ...(options.device ? ['-s', options.device] : [])];

  console.log(`Installing ${applicationId}.`);
  await exec(adb[0], [...adb.slice(1), 'install', '-r', apkPath]);

  // Without this the app's localhost is the device's own, and it dials into
  // nothing. It is the step most easily forgotten and the one whose absence
  // looks exactly like a broken build.
  await exec(adb[0], [...adb.slice(1), 'reverse', `tcp:${port}`, `tcp:${port}`]);
  console.log(`Reversed port ${port}, so the app reaches this machine on localhost.`);

  if (options.launch !== false) {
    const resolved = await execCapture(adb[0], [...adb.slice(1), 'shell', 'cmd', 'package', 'resolve-activity', '--brief', applicationId]);
    const component = resolved.trim().split('\n').map((line) => line.trim()).filter((line) => line.includes('/')).pop();
    if (component) {
      await exec(adb[0], [...adb.slice(1), 'shell', 'am', 'start', '-n', component]);
      console.log(`Launched ${component}.`);
    }
  }

  console.log('');
  console.log('Ready. Record it with:');
  console.log('  tracesift record start --platform rn');

  return { applicationId, apkPath, sourceMap, staleMap: Boolean(stale), port };
}
