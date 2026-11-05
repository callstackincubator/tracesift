# @callstack/tracesift-rn-profiler

Record a Hermes CPU profile from a React Native **release or profiling build**, with no Metro and no debugger.

`tracesift record start --platform rn` normally attaches to the Metro inspector, which only a debug build registers with. This package gives a release build something to attach to instead: it drives Hermes' sampling profiler directly and dials the CLI.

Nothing is rebuilt from source. The sampling profiler is already in the published `react-android` artifact and the stock `hermes-engine` pod — it does not depend on the Hermes debugger, and it is reachable without a `jsi::Runtime` reference, which is why no React Native fork is involved.

## Use it

From the root of your app:

```bash
npx tracesift profile build
```

```bash
npx tracesift record start --platform rn
```

That is the whole integration. The first command adds this package, assembles the release variant with profiling armed, installs it, reverses the port and launches the app; the second records. Stop with `tracesift record stop`.

Nothing in your project is edited. Autolinking finds the package, so there is no import to add and no app code to write.

## The gate

The profiler is **off unless a build asks for it**. A release binary that opens a control socket on request is a remote-profiling backdoor, so arming it is a build-time decision — a Gradle property this package's own manifest placeholder reads:

```bash
./gradlew assembleRelease -PtracesiftProfiler=true
```

`profile build` passes it for you. A build you run yourself does not, so the package ships inert: the provider is registered, reads one bundle and returns. No socket, no thread, no cost.

To arm it permanently for a variant of your own, put `tracesiftProfiler=true` in `android/gradle.properties` — and be deliberate about which builds that reaches.

## Source maps

Release frames are reported at bundle positions, so a source map is needed to name them. Run `record start` from the app root and the CLI reads the one the React Native Gradle plugin writes to `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`. Otherwise point `--source-map` at it.

## Options

| | |
|---|---|
| `tracesift profile build --variant profiling` | assemble a variant other than `release` |
| `tracesift profile build --device emulator-5554` | pick one of several attached devices |
| `tracesift profile build --no-install` | do not touch `package.json` (for CI) |
| `tracesift profile build --no-launch` | install but leave the app closed |
| `--profiler-port 9100` | on both commands, if 8089 is taken |

## Driving it from JS instead

Only needed to profile something the CLI cannot bracket from outside:

```ts
import { startProfiling, stopProfiling } from '@callstack/tracesift-rn-profiler';

startProfiling();
// ...
const path = await stopProfiling(); // a Hermes sampling profile on the device
```

Hermes clears its buffer as it dumps, so each profile can be collected exactly once.

## Status

Android. iOS uses the same protocol and is not implemented yet; on iOS a release build can already be profiled over CDP by building React Native from source.
