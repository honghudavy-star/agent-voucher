import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const violations = [];
const owners = new Map([
  ["access-workspace", ["iam_", "cfg_", "mst_"]],
  ["runtime-audit", ["job_", "prc_", "aud_", "ops_"]],
  ["online-acquisition", ["conn_", "src_"]],
  ["evidence-vault", ["evd_"]],
  ["document-understanding", ["doc_"]],
]);

for await (const file of glob(["modules/**/*.ts", "packages/**/*.ts"])) {
  const source = await readFile(file, "utf8");
  const owner = [...owners.keys()].find((name) => file.includes(`/modules/${name}/`) || file.includes(`modules/${name}/`));
  if (owner) {
    for (const other of owners.keys()) {
      if (other !== owner && source.includes(`@agent-voucher/${other}`)) violations.push(`${file}: ${owner} imports ${other}`);
    }
    const allowedPrefixes = owners.get(owner) ?? [];
    for (const match of source.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)) {
      const table = match[1] ?? "";
      if (!allowedPrefixes.some((prefix) => table.startsWith(prefix))) violations.push(`${file}: ${owner} tries to own ${table}`);
    }
  }
  if (file.includes("shared-kernel") && /fastify|better-sqlite3|langgraph|@agent-voucher\//.test(source)) {
    violations.push(`${file}: shared kernel imports infrastructure or a feature module`);
  }
}

if (violations.length) {
  console.error(violations.join("\n")); process.exit(1);
}
console.log("Architecture boundary check passed.");
