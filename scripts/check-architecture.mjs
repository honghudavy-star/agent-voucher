import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const violations = [];
for await (const file of glob(["modules/**/*.ts", "packages/**/*.ts"])) {
  const source = await readFile(file, "utf8");
  if (file.includes("access-workspace") && source.includes("runtime-audit")) violations.push(`${file}: A01 imports A02`);
  if (file.includes("shared-kernel") && /fastify|better-sqlite3|langgraph/.test(source)) violations.push(`${file}: shared kernel imports infrastructure`);
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Architecture boundary check passed.");
