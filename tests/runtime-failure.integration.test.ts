import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApplicationRuntime } from "../src/runtime/application.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";

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
});
