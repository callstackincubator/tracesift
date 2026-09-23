export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeRuntime } = await import("@callstack/tracesift/runtime");
    await initializeRuntime();
  }
}
