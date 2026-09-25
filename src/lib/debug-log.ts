/** Write verbose diagnostics only while running the development server. */
export function debugLog(label: string, ...parts: unknown[]): void {
  if (process.env.NODE_ENV !== "development") return;
  console.log(`[tracesift] ${new Date().toISOString()} [${label}]`, ...parts);
}
