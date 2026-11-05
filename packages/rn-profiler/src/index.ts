import { NativeModules } from 'react-native';

/**
 * The optional JS API.
 *
 * The package does not need it: with profiling enabled the native side dials
 * the tracesift CLI on its own and `tracesift record start --platform rn`
 * drives the whole recording. Reach for these only to profile something the
 * CLI cannot bracket from outside — a path you can only trigger in-app, or an
 * automated run that starts and stops around a known interaction.
 */
const native = NativeModules.TracesiftProfiler as
  | { startProfiling(): boolean; stopProfiling(): Promise<string> }
  | undefined;

function required() {
  if (!native) {
    throw new Error(
      '@callstack/tracesift-rn-profiler is not linked. Rebuild the app after installing it.',
    );
  }
  return native;
}

/** Arm Hermes' sampling profiler. */
export function startProfiling(): boolean {
  return required().startProfiling();
}

/**
 * Stop sampling and write the profile out.
 *
 * Resolves with the path of a Hermes sampling profile on the device. Hermes
 * clears its buffer as it dumps, so each profile can be collected once. Pass
 * the file to `tracesift` to convert and analyse it.
 */
export function stopProfiling(): Promise<string> {
  return required().stopProfiling();
}
