import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultDataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Agent Voucher");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Agent Voucher");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-voucher");
}

export const resolveDataDir = (input?: string): string => resolve(input ?? process.env.AGENT_VOUCHER_DATA_DIR ?? defaultDataDir());

export const dataPaths = (dataDir: string) => ({
  dataDir,
  dbDir: join(dataDir, "db"),
  appDb: join(dataDir, "db", "app.db"),
  graphDb: join(dataDir, "db", "graph.db"),
  backupsDir: join(dataDir, "backups"),
  logsDir: join(dataDir, "logs"),
  lockFile: join(dataDir, ".instance.lock"),
});
