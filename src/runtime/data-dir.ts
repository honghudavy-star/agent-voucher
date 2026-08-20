import { chmod, lstat, mkdir } from "node:fs/promises";
import { dataPaths } from "./paths.js";

export async function prepareDataDir(dataDir: string): Promise<ReturnType<typeof dataPaths>> {
  const paths = dataPaths(dataDir);
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(paths.dataDir);
  if (stat.isSymbolicLink()) throw new Error("数据目录不能是符号链接");
  await Promise.all([paths.dbDir, paths.backupsDir, paths.logsDir].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  if (process.platform !== "win32") await chmod(paths.dataDir, 0o700);
  return paths;
}
