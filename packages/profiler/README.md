# @callstack/tracesift-profiler

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

## iOS

```bash
npx tracesift profile build --platform ios
npx tracesift record start --platform rn
```

`profile build --platform ios` links the pod (`pod install`, which rewrites `Podfile.lock` and `Pods/` but never your Podfile), builds the release configuration for the simulator, installs and launches it. The simulator shares your Mac's `localhost`, so no port forwarding is needed. Physical devices and JSC are not supported.

The gate is an `Info.plist` key, `TracesiftProfilingEnabled`, which `profile build` sets on the **built app only** (and re-signs it). Your project's plist is not edited, and a build you make yourself ships the package inert. The profiler calls Hermes through `IHermesRootAPI` and touches it only when the CLI sends start or stop.

## Source maps

On iOS there is no fixed path, so `profile build` tells Xcode where to write one (`SOURCEMAP_FILE`): `ios/build/tracesift/main.jsbundle.map`, which `record start` reads from the app root. For a build you made yourself, pass `--source-map`.

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
import { startProfiling, stopProfiling } from '@callstack/tracesift-profiler';

startProfiling();
// ...
const path = await stopProfiling(); // a Hermes sampling profile on the device
```

Hermes clears its buffer as it dumps, so each profile can be collected exactly once.

## Status

Android, the iOS simulator and USB-attached iPhones.

A physical iPhone cannot dial the Mac, and iOS has no `adb reverse`. So `tracesift profile build --platform ios --device <udid>` arms the build with `TracesiftProfilerTransport = listen`: the app serves on the phone's end of its CoreDevice tunnel (a point-to-point IPv6 link between that phone and this Mac, on a `utun` interface) and `record start --platform rn` dials it. The app binds that address only, never a wildcard, so the port is not on any LAN. Use a cable, keep the phone unlocked, and sign the app target with a development team in Xcode. `tracesift profile devices` lists what `--device` accepts.
