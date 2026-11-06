#!/usr/bin/env node
import { recorderMain } from './record-session.js';

await recorderMain(process.argv.slice(2));
