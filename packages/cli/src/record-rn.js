// Choosing between the two React Native capture routes.
import { defaultMetroOrigin, metroTargets, parseMetroOrigin, selectMetroTarget } from './metro.js';
import { awaitProfilerApp, DEFAULT_PROFILER_PORT, noAppConnectedMessage, RELEASE_TARGET_PREFIX, releaseSelection } from './rn-profiler-link.js';
import { errorText } from './record-common.js';
import { writeRecordState } from './record-state.js';

// How long to hold the port open for a release build before giving up.
const CONNECT_TIMEOUT_MS = 20_000;

/** Record from whichever React Native app we can reach. */
export async function runRnAnyRecording(options) {
  const port = options.profilerPort ?? DEFAULT_PROFILER_PORT;
  // A chosen `release:<device>` target is never a Metro target: skip Metro and
  // accept only that device's app.
  const chosen = typeof options.targetId === 'string' && options.targetId.startsWith(RELEASE_TARGET_PREFIX);
  const selection = chosen ? await releaseSelection(options.targetId) : {};

  // The listener goes up first so an app that is already retrying its dial is
  // caught while Metro is still being probed.
  const controller = new AbortController();
  const pending = awaitProfilerApp({ port, signal: controller.signal, ...selection });
  // Nothing awaits this until Metro has been ruled out, and an unobserved
  // rejection in between would take the recorder down with it.
  pending.catch(() => undefined);

  const metroFailure = chosen ? 'A release build was chosen.' : await probeMetro(options);
  if (!metroFailure) {
    controller.abort(new Error('Recording over Metro instead.'));
    pending.then((link) => link.close()).catch(() => undefined);
    const { runRnRecording } = await import('./record-rn-session.js');
    return runRnRecording(options);
  }

  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(noAppConnectedMessage(metroFailure, port))), CONNECT_TIMEOUT_MS);
    timer.unref?.();
  });
  deadline.catch(() => undefined);

  let link;
  try {
    link = await Promise.race([pending, deadline]);
  } catch (error) {
    // Neither recorder ever started, so neither has written a record state.
    // Without one `record start` waits out its own budget and reports a
    // timeout in place of the reason collected here.
    await writeRecordState(options.home, {
      apiVersion: 1,
      pid: process.pid,
      mode: 'local',
      state: 'failed',
      startedAt: Date.now(),
      url: `http://127.0.0.1:${port}`,
      targetLabel: 'React Native app',
      error: errorText(error),
    }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort(new Error('Gave up waiting for a release build.'));
  }

  const { runRnReleaseRecording } = await import('./rn-release-session.js');
  return runRnReleaseRecording({ ...options, link });
}

/** Is there a debug build on Metro we can attach to? */
async function probeMetro(options) {
  try {
    const origin = parseMetroOrigin(options.metro || defaultMetroOrigin());
    const found = await metroTargets(origin);
    selectMetroTarget(found, {
      app: options.app, device: options.device, targetId: options.targetId, origin,
    });
    return null;
  } catch (error) {
    return errorText(error);
  }
}
