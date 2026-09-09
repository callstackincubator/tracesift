import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  transpilePackages: ["@rozenite/ui"],
  // The pi coding agent SDK is a Node-heavy ESM package; keep it out of the
  // server bundle and load it with native Node resolution.
  serverExternalPackages: ["@callstack/perf-ai", "@earendil-works/pi-coding-agent"],
};

export default nextConfig;
