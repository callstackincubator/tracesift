import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // The pi coding agent SDK is a Node-heavy ESM package; keep it out of the
  // server bundle and load it with native Node resolution.
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
};

export default nextConfig;
