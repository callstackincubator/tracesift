import { NativeModules } from 'react-native';

/** The optional JS API. */
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

/** Stop sampling and write the profile out. */
export function stopProfiling(): Promise<string> {
  return required().stopProfiling();
}
