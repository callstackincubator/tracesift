export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeRuntime } = await import("@callstack/perf-ai/runtime");
    await initializeRuntime();
  }
}
