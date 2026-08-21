import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CLI contract", () => {
  it("provides stable help and version output", () => {
    const help = spawnSync(process.execPath, ["dist/cli.js", "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("start [options]");
    expect(help.stdout).toContain("doctor [options]");
    expect(help.stdout).toContain("restore [options] <backup>");
    const version = spawnSync(process.execPath, ["dist/cli.js", "--version"], { encoding: "utf8" });
    expect(version.stdout.trim()).toBe("0.1.0");
  });

  it("emits non-interactive shell completions", () => {
    const result = spawnSync(process.execPath, ["dist/cli.js", "completions", "bash"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("complete -W");
  });

  it("packages the setup bootstrap script with public assets", async () => {
    await expect(access("assets/app.js")).resolves.toBeUndefined();
    await expect(access("dist/parser-worker.js")).resolves.toBeUndefined();
    await expect(access("vendor/xlsx-0.20.3.tgz")).resolves.toBeUndefined();
    expect(await readFile("assets/app.js", "utf8")).toContain("window.confirm");
  });

  it("returns a nonzero doctor status for a corrupt Graph database", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-doctor-corrupt-"));
    try {
      await mkdir(join(root, "db"), { recursive: true });
      await writeFile(join(root, "db", "graph.db"), "not-sqlite");
      const result = spawnSync(process.execPath, ["dist/cli.js", "doctor", "--data-dir", root, "--json"], { encoding: "utf8" });
      expect(result.status).not.toBe(0); expect(`${result.stdout}${result.stderr}`).toMatch(/Graph|database|SQLite|file is not a database/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
