// `tracesift profile build` — turn an app into a profiling build and get it
// onto the device, without the developer editing anything.
//
// Profiling a release build needs three things to line up: the profiler
// package in the app, the Gradle property that arms it, and a reverse port so
// the app's localhost is the developer's. None is difficult and all three are
// easy to get wrong in a way that fails silently — an app built without the
// property simply never dials, and the recording times out saying so.
//
// So the command does all three. It is the difference between "install this,
// add a line to your manifest, remember a -P flag, remember adb reverse" and
// one command.
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEFAULT_PROFILER_PORT } from './rn-profiler-link.js';

export const PROFILER_PACKAGE = '@callstack/tracesift-rn-profiler';
/** The Gradle property the library's manifest placeholder reads. */
export const PROFILER_GRADLE_PROPERTY = 'tracesiftProfiler';

export const PROFILE_SUBCOMMANDS = ['build'];

/** Which options each `profile` subcommand understands. */
const PROFILE_OPTIONS = {
  build: ['platform', 'variant', 'device', 'profiler-port', 'no-install', 'no-launch'],
};

/**
 * Reject an option `profile` would silently ignore, the way `record` does:
 * a flag that looks honoured but is not is worse than one that is refused.
 */
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

/**
 * Which package manager the project uses.
 *
 * Read off the lockfile rather than asked for: installing with the wrong one
 * leaves two lockfiles disagreeing, which is a worse day than a missing flag.
 */
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

/**
 * Read the applicationId and apk filename out of the metadata the Android
 * Gradle plugin writes beside the build. Guessing either from the Gradle
 * files means reproducing AGP's variant and flavour rules, and getting it
 * wrong installs the wrong apk.
 *
 * @param {string} androidRoot
 * @param {string} variant
 */
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

/** Where the React Native Gradle plugin writes the variant's source map. */
export function sourceMapPathFor(androidRoot, variant) {
  return join(androidRoot, 'app', 'build', 'generated', 'sourcemaps', 'react', variant, 'index.android.bundle.map');
}

/** Run a command, inheriting stdio so the build's own output is the output. */
function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args[0] ?? ''} failed with exit code ${code}.`));
    });
  });
}

/** Run a command and capture stdout, for the ones we read rather than show. */
function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new Error(`${command} ${args[0] ?? ''} failed: ${err.trim() || out.trim() || `exit code ${code}`}`));
    });
  });
}

/**
 * Build, install and arm a profiling build.
 *
 * @param {{
 *   platform?: string,
 *   projectRoot?: string,
 *   variant?: string,
 *   device?: string,
 *   profilerPort?: number,
 *   install?: boolean,
 *   launch?: boolean,
 *   exec?: typeof run,
 *   execCapture?: typeof capture,
 * }} options
 */
export async function profileBuild(options = {}) {
  const platform = options.platform ?? 'android';
  if (platform !== 'android') {
    throw new Error('tracesift profile build supports --platform android. On iOS a release build can be profiled over the Metro inspector by building React Native from source.');
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

  const task = assembleTask(variant);
  console.log(`Building ${task} with profiling armed (-P${PROFILER_GRADLE_PROPERTY}=true).`);
  await exec(gradlew, [task, `-P${PROFILER_GRADLE_PROPERTY}=true`], { cwd: androidRoot });

  const { applicationId, apkPath } = await readApkMetadata(androidRoot, variant);
  const adb = ['adb', ...(options.device ? ['-s', options.device] : [])];

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

  const sourceMap = sourceMapPathFor(androidRoot, variant);
  const hasSourceMap = await exists(sourceMap);
  console.log('');
  console.log('Ready. Record it with:');
  console.log(`  tracesift record start --platform rn${hasSourceMap ? '' : ` --source-map <path>`}`);
  if (!hasSourceMap) {
    console.log(`\nNo source map at ${sourceMap}, so frames would be reported at bundle positions. Point --source-map at the one your build produces.`);
  }

  return { applicationId, apkPath, sourceMap: hasSourceMap ? sourceMap : null, port };
}
