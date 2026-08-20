import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command, Option } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { AccessWorkspaceService } from "@agent-voucher/access-workspace";
import { RuntimeAuditService } from "@agent-voucher/runtime-audit";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import { DbClient } from "./infrastructure/db/client.js";
import { GraphClient } from "./infrastructure/graph/client.js";
import { createBackup, restoreBackup } from "./runtime/backup.js";
import { prepareDataDir } from "./runtime/data-dir.js";
import { acquireInstanceLock } from "./runtime/instance-lock.js";
import { resolveDataDir } from "./runtime/paths.js";
import { ApplicationRuntime } from "./runtime/application.js";

const program = new Command();
const systemActor: ActorSnapshot = { userId: "SYSTEM", username: "cli", roles: ["ADMIN"] };

function ensureNode24(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) throw new Error(`Agent Voucher 需要 Node.js 24 LTS 或更高版本；当前为 ${process.versions.node}`);
}

function portValue(input: string): number {
  const port = Number(input);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是1到65535之间的整数");
  return port;
}

function dataDirOption(command: Command): Command {
  return command.option("--data-dir <path>", "应用数据目录", process.env.AGENT_VOUCHER_DATA_DIR);
}

program.name("agent-voucher").description("本地优先的账证基础工作台").version(packageJson.version);

dataDirOption(program.command("start").description("以前台模式启动Web工作台")
  .option("--port <number>", "监听端口", process.env.AGENT_VOUCHER_PORT ?? "8765")
  .option("--no-open", "不自动打开浏览器")
  .option("--lan", "绑定私有局域网（未加密HTTP）", false))
  .action(async (options: { port: string; dataDir?: string; open: boolean; lan: boolean }) => {
    ensureNode24();
    const runtime = new ApplicationRuntime();
    const port = portValue(options.port); const dataDir = resolveDataDir(options.dataDir);
    const shutdown = async (signal: string) => {
      console.error(`\n收到 ${signal}，正在安全停止…`);
      await runtime.shutdown();
      process.exitCode = signal === "SIGINT" ? 130 : 0;
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    const started = await runtime.start({ dataDir, port, lanMode: options.lan, noOpen: !options.open });
    console.error(`Agent Voucher ${packageJson.version} 已启动`);
    console.error(`本机地址: ${started.url}`);
    console.error(`数据目录: ${dataDir}`);
    if (started.setupUrl) console.error(`初始化链接（15分钟有效）: ${started.setupUrl}`);
    if (options.lan) {
      console.error("警告: 局域网模式使用未加密HTTP，只能用于受信、隔离的私有网络；禁止公网暴露。");
      for (const url of runtime.lanUrls(port)) console.error(`局域网地址: ${url}`);
    }
  });

dataDirOption(program.command("doctor").description("检查数据库、Graph和数据目录")
  .option("--json", "输出JSON", false))
  .action(async (options: { dataDir?: string; json: boolean }) => {
    ensureNode24(); const paths = await prepareDataDir(resolveDataDir(options.dataDir));
    const lock = await acquireInstanceLock(paths.lockFile);
    const db = new DbClient(paths.appDb); const graph = new GraphClient(paths.graphDb);
    try {
      await db.start(); await graph.start();
      const report = { dataDir: paths.dataDir, database: await db.health(), graph: await graph.health(), node: process.versions.node };
      if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        console.error(`数据目录: ${report.dataDir}`);
        console.error(`SQLite: ${report.database.quickCheck === "ok" ? "正常" : "异常"}`);
        console.error(`Graph: ${report.graph.ready ? "正常" : "异常"}`);
        console.error(`Node.js: ${report.node}`);
      }
    } finally { await graph.close(); await db.close(); await lock.release(); }
  });

dataDirOption(program.command("backup").description("创建一致性数据库备份")
  .option("--output <path>", "备份输出目录"))
  .action(async (options: { dataDir?: string; output?: string }) => {
    ensureNode24(); const paths = await prepareDataDir(resolveDataDir(options.dataDir)); const lock = await acquireInstanceLock(paths.lockFile);
    const db = new DbClient(paths.appDb); const graph = new GraphClient(paths.graphDb);
    try {
      await db.start(); await graph.start();
      const access = new AccessWorkspaceService(db); const runtime = new RuntimeAuditService(db, graph);
      const destination = await createBackup(paths.dataDir, db, graph, runtime, systemActor, options.output);
      console.error(`备份已验证: ${destination}`);
      void access;
    } finally { await graph.close(); await db.close(); await lock.release(); }
  });

dataDirOption(program.command("restore <backup>").description("从已验证备份离线恢复")
  .option("--yes", "跳过交互确认", false))
  .action(async (backup: string, options: { dataDir?: string; yes: boolean }) => {
    ensureNode24(); const paths = await prepareDataDir(resolveDataDir(options.dataDir)); const lock = await acquireInstanceLock(paths.lockFile);
    try {
      if (!options.yes) {
        if (!stdin.isTTY) throw new Error("非交互环境必须提供 --yes");
        const prompt = createInterface({ input: stdin, output: stdout });
        const answer = await prompt.question("恢复会替换当前数据库。输入 RESTORE 继续: "); prompt.close();
        if (answer !== "RESTORE") throw new Error("已取消恢复");
      }
      const backupId = await restoreBackup(paths.dataDir, backup);
      console.error(`恢复完成，备份ID: ${backupId}`);
    } finally { await lock.release(); }
  });

program.command("completions <shell>").description("输出shell补全脚本")
  .addOption(new Option("--unused").hideHelp())
  .action((shell: string) => {
    const commands = "start doctor backup restore completions";
    if (shell === "bash") stdout.write(`complete -W "${commands}" agent-voucher\n`);
    else if (shell === "zsh") stdout.write(`#compdef agent-voucher\n_arguments '1:command:(${commands})'\n`);
    else if (shell === "fish") for (const command of commands.split(" ")) stdout.write(`complete -c agent-voucher -f -a ${command}\n`);
    else throw new Error("shell必须是 bash、zsh 或 fish");
  });

program.showHelpAfterError();
program.configureOutput({
  writeErr: (text) => process.stderr.write(text),
  outputError: (text, write) => write(`错误: ${text}`),
});

void program.parseAsync().catch((error: unknown) => {
  console.error(`错误: ${error instanceof Error ? error.message : "命令执行失败"}`);
  if (process.env.AGENT_VOUCHER_DEBUG === "1" && error instanceof Error) console.error(error.stack);
  process.exitCode = 1;
});
