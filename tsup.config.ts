import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "db-worker": "src/infrastructure/db/worker.ts",
    "graph-worker": "src/infrastructure/graph/worker.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  external: ["better-sqlite3"],
});
