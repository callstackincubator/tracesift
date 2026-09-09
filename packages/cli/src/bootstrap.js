// Next.js can defer instrumentation until its first request. Preload the snapshot
// before Next starts listening, including missing or invalid configuration.
import { initializeRuntime } from './runtime.js';
await initializeRuntime();
