import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findPackageRoot(start: string): string {
  let current = resolve(start);
  const root = parse(current).root;
  while (current !== root) {
    if (existsSync(join(current, "package.json"))) return current;
    current = dirname(current);
  }
  throw new Error("无法定位Agent Voucher包目录");
}

export const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
