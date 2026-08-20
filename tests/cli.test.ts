import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
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
  });
});
