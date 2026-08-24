import { spawn } from "node:child_process";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { EventEmitter } from "node:events";
import { PARSER_LIMITS, ParserRequestSchema, decodeParserResponse, encodeParserMessage } from "./parser-protocol.js";
import type { ParserErrorCode, ParserRequest, ParserResponse } from "./parser-protocol.js";

interface WritableInput {
  end(data: string): void;
}

interface ParserChildProcess {
  readonly stdin: WritableInput;
  readonly stdout: Pick<EventEmitter, "on">;
  readonly stderr: Pick<EventEmitter, "on">;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ParserSpawnFactory = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { readonly stdio: readonly ["pipe", "pipe", "pipe"] },
) => ParserChildProcess;

export interface ParserLauncherOptions {
  readonly entryPath: string;
  readonly resourceReadPaths?: readonly string[];
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly spawnFactory?: ParserSpawnFactory;
  readonly signal?: AbortSignal;
}

export class ParserProcessError extends Error {
  constructor(readonly code: ParserErrorCode, message: string) {
    super(message);
    this.name = "ParserProcessError";
  }
}

const SAFE_ENVIRONMENT_KEYS = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"] as const;

export function sanitizedParserEnvironment(source: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const safe: Record<string, string> = { NODE_ENV: "production", NO_COLOR: "1" };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) safe[key] = value;
  }
  return Object.freeze(safe);
}

export function parserProcessArgs(request: ParserRequest, options: ParserLauncherOptions): readonly string[] {
  const filePath = resolve(request.filePath);
  const readPaths = [filePath, resolve(options.entryPath), ...(options.resourceReadPaths ?? []).map((path) => resolve(path))];
  return Object.freeze([
    `--max-old-space-size=${PARSER_LIMITS.maxOldSpaceMb}`,
    "--permission",
    ...readPaths.map((path) => `--allow-fs-read=${path}`),
    resolve(options.entryPath),
  ]);
}

const defaultSpawnFactory: ParserSpawnFactory = (executable, args, options) => spawn(executable, args, options);

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

export async function runParserSubprocess(
  rawRequest: ParserRequest,
  options: ParserLauncherOptions,
): Promise<ParserResponse> {
  if (rawRequest.fileSizeBytes > PARSER_LIMITS.maxFileBytes) {
    throw new ParserProcessError("FILE_TOO_LARGE", `Parser input exceeds ${PARSER_LIMITS.maxFileBytes} bytes`);
  }
  const parsedRequest = ParserRequestSchema.safeParse(rawRequest);
  if (!parsedRequest.success) throw new ParserProcessError("INVALID_REQUEST", "Parser request failed schema validation");
  const request = parsedRequest.data;
  if (!isAbsolute(request.filePath)) throw new ParserProcessError("INVALID_REQUEST", "Parser filePath must be absolute");
  if (!isAbsolute(options.entryPath)) throw new ParserProcessError("INVALID_REQUEST", "Parser entryPath must be absolute");
  const timeoutMs = options.timeoutMs ?? PARSER_LIMITS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PARSER_LIMITS.timeoutMs) {
    throw new ParserProcessError("INVALID_REQUEST", `Parser timeout must be between 1 and ${PARSER_LIMITS.timeoutMs} ms`);
  }
  if (options.signal?.aborted) throw new ParserProcessError("PARSER_CANCELED", "Parser request was canceled");

  const child = (options.spawnFactory ?? defaultSpawnFactory)(
    options.executable ?? process.execPath,
    parserProcessArgs(request, options),
    { env: sanitizedParserEnvironment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );

  return await new Promise<ParserResponse>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let response: ParserResponse | undefined;
    let settled = false;

    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      rejectPromise(error);
    };
    const finishResolve = (value: ParserResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishReject(new ParserProcessError("PARSER_TIMEOUT", `Parser exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    const cancel = (): void => {
      child.kill("SIGKILL"); finishReject(new ParserProcessError("PARSER_CANCELED", "Parser request was canceled"));
    };
    options.signal?.addEventListener("abort", cancel, { once: true });

    child.stdout.on("data", (chunk: unknown) => {
      if (settled) return;
      stdout += chunkText(chunk);
      if (Buffer.byteLength(stdout, "utf8") > PARSER_LIMITS.maxResponseBytes) {
        child.kill("SIGKILL");
        finishReject(new ParserProcessError("INVALID_RESPONSE", "Parser response exceeded the size limit"));
        return;
      }
      const newline = stdout.indexOf("\n");
      if (newline < 0 || response) return;
      try {
        response = decodeParserResponse(stdout.slice(0, newline));
        if (response.requestId !== request.requestId) {
          child.kill("SIGKILL");
          finishReject(new ParserProcessError("INVALID_RESPONSE", "Parser response requestId mismatch"));
        }
      } catch {
        child.kill("SIGKILL");
        finishReject(new ParserProcessError("INVALID_RESPONSE", "Parser emitted invalid JSON protocol data"));
      }
    });
    child.stderr.on("data", (chunk: unknown) => {
      if (stderr.length < 8_192) stderr += chunkText(chunk);
    });
    child.once("error", (error) => finishReject(new ParserProcessError("PARSER_CRASHED", error.message)));
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (response) return finishResolve(response);
      const oom = /heap out of memory|allocation failed/i.test(stderr);
      finishReject(new ParserProcessError(
        oom ? "PARSER_OOM" : "PARSER_CRASHED",
        `Parser exited without a response (code=${String(code)}, signal=${String(signal)})`,
      ));
    });
    try {
      child.stdin.end(encodeParserMessage(request));
    } catch (error) {
      finishReject(new ParserProcessError("PARSER_CRASHED", error instanceof Error ? error.message : "Parser stdin failed"));
    }
  });
}
