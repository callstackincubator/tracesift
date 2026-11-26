// Regenerates trace.json.gz from a real release export (the .json.gz that
// `tracesift record stop` writes). Usage:
//   node test-fixtures/release-ios/make-fixture.mjs <export.json.gz>
//
// The trace is kept whole. The map is pruned to the segments the trace's frames
// land on (plus the sourceless segments two of them land on), because the full
// Metro/Hermes map is 8 MB. `originalPositionFor` answers identically for every
// frame in the trace; the test re-checks that against the frames it asserts.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { AnyMap, eachMapping } from '@jridgewell/trace-mapping';
import { encode } from '@jridgewell/sourcemap-codec';

const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(process.argv[2])));
const [entry] = raw.metadata.sourceMaps;
const full = entry.sourceMap;

const wanted = new Set();
for (const event of raw.traceEvents) {
  for (const node of event.args?.data?.cpuProfile?.nodes ?? []) {
    const f = node.callFrame;
    if (f.url === entry.url && f.lineNumber === 0) wanted.add(f.columnNumber);
  }
}

// A Hermes offset need not start a segment: the lookup falls back to the
// closest segment at or before it, so that one is what has to be kept.
const line1 = [];
eachMapping(new AnyMap(full), (m) => { if (m.generatedLine === 1) line1.push(m); });
line1.sort((a, b) => a.generatedColumn - b.generatedColumn);
const keep = new Set();
for (const column of wanted) {
  let lo = 0; let hi = line1.length - 1; let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (line1[mid].generatedColumn <= column) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (at >= 0) keep.add(at);
}

const sourceIndex = new Map();
const sources = [];
const segments = [];
for (const at of keep) {
  const m = line1[at];
  if (m.source == null) { segments.push([m.generatedColumn]); continue; }
  if (!sourceIndex.has(m.source)) { sourceIndex.set(m.source, sources.length); sources.push(m.source); }
  segments.push([m.generatedColumn, sourceIndex.get(m.source), m.originalLine - 1, m.originalColumn]);
}
segments.sort((a, b) => a[0] - b[0]);

entry.sourceMap = { version: 3, sources, names: [], mappings: encode([segments]) };
// The machine this was recorded on is not part of the fixture.
entry.sourceMapUrl = 'main.jsbundle.map';
if (raw.metadata.traceSift?.target) delete raw.metadata.traceSift.target.deviceName;

const out = new URL('./trace.json.gz', import.meta.url);
fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(raw), { level: 9 }));
console.log(`${wanted.size} distinct columns, ${segments.length} segments, ${sources.length} sources -> ${fs.statSync(out).size} bytes`);
