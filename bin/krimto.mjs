#!/usr/bin/env node
// npx entry: start the Krimto MCP server over stdio (solo, no Docker / no key).
// The server source is ESM with extensionless imports, so it is loaded through tsx's
// programmatic API — the same tsx-at-runtime approach the Dockerfile uses. No build step,
// no rewrite. With no KRIMTO_HTTP_PORT set, main() takes the stdio path automatically.
import process from "node:process";
import { tsImport } from "tsx/esm/api";

try {
  const mod = await tsImport("../src/server/index.ts", import.meta.url);
  await mod.main();
} catch (e) {
  process.stderr.write(`krimto: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
