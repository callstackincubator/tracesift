# @callstack/tracesift-profiler

## 0.7.0

### Minor Changes

- 64dedfa: Record React Native JavaScript profiles from debug and release builds. The CLI discovers running Metro targets and profiler-enabled release apps, records Hermes samples, and exports an enhanced trace to a running TraceSift service or a local `.json.gz` file. `profile build` prepares, installs, and launches profiler-enabled Android and iOS builds, including connected devices. Captures retain source maps and symbolicated frame names for analysis.
