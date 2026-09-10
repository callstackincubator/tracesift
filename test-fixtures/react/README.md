# React profiling fixture provenance

`react-native-v5.synthetic.json` is **synthetic**, authored for deterministic edge-case testing. It was not recorded on a device and has no claimed React Native or DevTools producer version.

Protocol reference: React **v19.1.0**, export format **5**, using `react-devtools-shared/src/devtools/views/Profiler/CommitTreeBuilder.js` and frontend element constants. Consumer under test: **agent-react-devtools 0.4.0 + local patch**. The fixture represents shared DevTools fields used by React Native, with `View` as a host node. It deliberately contains missing metadata/self data and repeated fiber IDs across roots to test robustness.

Expected results (milliseconds):

| Instance | Name | Render count | Total inclusive | Average inclusive | Max inclusive | Average self |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 10:2 | Row | 1 | 40 | 40 | 40 | 30 |
| 1:5 | Hëavy🧩 | 1 | 30 | 30 | 30 | 25 |
| 1:2 | Row | 3 | 30 | 10 | 20 | 2 |
| 1:3 | Row | 2 | 20 | 10 | 12 | unavailable |
| 1:6 | Component#6 | 1 | 9 | 9 | 9 | 5 |

Root 1 has three commits lasting 30, 30, and 10 ms; root 10 has one lasting 40 ms. Total commit render duration is 110 ms. `1:4` has only a zero-duration render and is omitted from positive-duration results. Root and host entries are excluded. `1:5` mounts in commit 1 and unmounts in commit 2. Unicode string-table decoding, reordered children, base durations, errors/warnings, and subtree mode are exercised.

To complete device validation, add a non-sensitive export from a React Native app and record React Native, React, and DevTools versions and capture procedure alongside it. Compare each chosen fiber's per-commit inclusive/self values and render participation with the matching DevTools UI; calculate the average over participating commits, since DevTools' ranked chart sorts self time within one commit. Do not claim that comparison has passed based on this synthetic fixture alone.
