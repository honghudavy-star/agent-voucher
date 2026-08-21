import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApplicationRuntime } from "../src/runtime/application.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";
import { acquireInstanceLock } from "../src/runtime/instance-lock.js";

describe("runtime failure recovery", () => {
  it("releases workers and the instance lock when the port is already occupied", async () => {
    const blocker = createHttpServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    const dataDir = await mkdtemp(join(tmpdir(), "agent-voucher-start-failure-"));
    const paths = await prepareDataDir(dataDir);
    const runtime = new ApplicationRuntime();
    try {
      await expect(runtime.start({ dataDir, port, lanMode: false, noOpen: true })).rejects.toThrow();
      await expect(access(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runtime.shutdown();
      await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a live second instance and recovers a stale lock", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agent-voucher-lock-"));
    const paths = await prepareDataDir(dataDir);
    const first = await acquireInstanceLock(paths.lockFile);
    try {
      await expect(acquireInstanceLock(paths.lockFile)).rejects.toThrow("数据目录已被进程");
    } finally { await first.release(); }
    await writeFile(paths.lockFile, JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }));
    const recovered = await acquireInstanceLock(paths.lockFile);
    await recovered.release();
    await expect(access(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(dataDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("rejects a symlink data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-symlink-"));
    const target = join(root, "target"); const link = join(root, "link");
    await mkdir(target); await symlink(target, link);
    await expect(prepareDataDir(link)).rejects.toThrow("数据目录不能是符号链接");
    await rm(root, { recursive: true, force: true });
  });
});
