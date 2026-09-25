import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(__dirname, "dist");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir,
  sourcemap: false,
  logLevel: "info",
};

// dist/cli.js: the moneyswitch bin. connect/status/remove logic bundled in;
// "./mcp.js" import left external (a real relative runtime import) so the
// @moneyswitch/mcp bundle is only loaded when `moneyswitch mcp` runs.
await build({
  ...shared,
  entryPoints: [path.join(__dirname, "src/cli.ts")],
  entryNames: "cli",
  external: ["./mcp.js"],
});

// dist/mcp.js: @moneyswitch/mcp (Apache-2.0) bundled standalone, including
// @modelcontextprotocol/sdk and zod so the published package has ~0 runtime
// npm dependencies.
await build({
  ...shared,
  entryPoints: [path.join(__dirname, "src/mcp-bin.ts")],
  entryNames: "mcp",
});

console.log("built dist/cli.js + dist/mcp.js");
