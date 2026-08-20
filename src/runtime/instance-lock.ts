import { open, readFile, rm } from "node:fs/promises";

export interface InstanceLock { release(): Promise<void> }

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function acquireInstanceLock(lockFile: string): Promise<InstanceLock> {
  const acquire = async () => {
    const handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  };
  try {
    await acquire();
  } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    let pid = 0;
    try { pid = Number((JSON.parse(await readFile(lockFile, "utf8")) as { pid?: number }).pid ?? 0); } catch { /* invalid stale lock */ }
    if (pid > 0 && processExists(pid)) throw new Error(`数据目录已被进程 ${pid} 使用，请先停止该实例`);
    await rm(lockFile, { force: true });
    await acquire();
  }
  return { release: async () => rm(lockFile, { force: true }) };
}
