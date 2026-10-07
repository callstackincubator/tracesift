import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { groupBottlenecks } from '../src/lib/bottlenecks.ts';
import { analyzeCpuBottlenecks, CpuAnalysisError, parseCpuHotspotReport } from '../src/lib/cpu-analyzer.ts';
import { ANALYSIS_MAX_OUTPUT_TOKENS, truncationMessage } from '../src/lib/pi-agent.ts';

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, costUsd: 0 };
const model = { provider: "Anthropic", model: "Claude test" };

function measuredGroups() {
  const nodes = [
    { id: 0, children: [1], callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 } },
    { id: 1, children: [2], callFrame: { functionName: 'onMessagePress', url: 'src/message.ts', lineNumber: 9, columnNumber: 2 } },
    { id: 2, children: [], callFrame: { functionName: 'tokenizeMarkdown', url: 'src/markdown.ts', lineNumber: 11, columnNumber: 3 } },
  ];
  return groupBottlenecks({ nodes, samples: [2, 2], startTime: 0, endTime: 100_000 }, 100);
}

test('CPU analyzer requests one bounded JSON response with no tools', async () => {
  const groups = measuredGroups();
  let calls = 0;
  const result = await analyzeCpuBottlenecks(groups, 100, tmpdir(), { fixture: true }, async (options) => {
    calls += 1;
    assert.deepEqual(options.builtinTools, []);
    assert.deepEqual(options.customTools, []);
    assert.equal(options.maxOutputTokens, ANALYSIS_MAX_OUTPUT_TOKENS);
    assert.deepEqual(options.inputBreakdown, { fixture: true });
    assert.match(options.systemPrompt, /Return exactly one JSON object/);
    assert.doesNotMatch(options.systemPrompt, /report_hotspots/);
    assert.doesNotMatch(options.systemPrompt, /date formatting|localeCompare|DateTimeFormat/);
    assert.match(options.prompt, /tokenizeMarkdown/);
    return {
      finalText: JSON.stringify({ hotspots: [{
        id: groups[0].id,
        title: 'Expensive markdown tokenization',
        functions: [{ id: groups[0].functions[0].id, evidence: 'tokenizeMarkdown accounts for the measured self time.' }],
      }] }),
      turns: 1, toolCalls: [], lastStopReason: 'stop', usage, model,
    };
  });
  assert.equal(calls, 1);
  assert.equal(result.hotspots[0].title, 'Expensive markdown tokenization');
  assert.equal(result.hotspots[0].combinedTimeMs, 100);
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(result.model, model);
});

test('CPU report parser accepts exact and fenced JSON but rejects empty reports', () => {
  const report = { hotspots: [{ id: 'b1' }] };
  assert.deepEqual(parseCpuHotspotReport(JSON.stringify(report)), report);
  assert.deepEqual(parseCpuHotspotReport(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``), report);
  assert.deepEqual(parseCpuHotspotReport(`Result:\n${JSON.stringify(report)}\nDone.`), report);
  assert.equal(parseCpuHotspotReport('{"hotspots":[]}'), null);
  assert.equal(parseCpuHotspotReport('not json'), null);
});

test('CPU analyzer fails once when the final response has no usable report', async () => {
  await assert.rejects(
    analyzeCpuBottlenecks(measuredGroups(), 100, tmpdir(), undefined, async () => ({
      finalText: '{"hotspots":[]}', turns: 1, toolCalls: [], lastStopReason: 'stop', usage,
    })),
    (error) => error instanceof CpuAnalysisError && error.status === 502,
  );
});

test('the output budget leaves room for reasoning tokens, which are billed against it', () => {
  // A reasoning model can spend the whole budget thinking and return no text at
  // all, so the cap has to exceed what a report alone would need.
  assert.ok(ANALYSIS_MAX_OUTPUT_TOKENS > 4096, 'budget must exceed the reasoning burst that exhausted it');
  assert.match(truncationMessage(''), /entire output budget on reasoning/);
  assert.match(truncationMessage('{"hotspots":'), /cut off at the model's output token limit/);
});
