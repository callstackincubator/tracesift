#!/usr/bin/env node
import { runRnAnyRecording } from './record-rn.js';
import { errorText } from './record-common.js';

try {
  await runRnAnyRecording(JSON.parse(process.argv[2]));
} catch (error) {
  console.error(`tracesift: ${errorText(error)}`);
  process.exitCode = 1;
}
