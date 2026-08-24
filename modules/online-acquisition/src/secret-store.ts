import { spawn } from "node:child_process";
import type { SecretStore, SecretStoreAvailability } from "./contracts.js";
import type { SecretReference } from "./types.js";

const RESOURCE_PREFIX = "AgentVoucher/Feishu/";

export class SecretStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreUnavailableError";
  }
}

export class InMemorySecretStore implements SecretStore {
  readonly #values = new Map<SecretReference, string>();

  availability(): Promise<SecretStoreAvailability> {
    return Promise.resolve({ available: true, persistent: false });
  }

  save(reference: SecretReference, secret: string): Promise<void> {
    if (secret.length === 0) throw new Error("secret must not be empty");
    this.#values.set(reference, secret);
    return Promise.resolve();
  }

  read(reference: SecretReference): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(reference));
  }

  delete(reference: SecretReference): Promise<void> {
    this.#values.delete(reference);
    return Promise.resolve();
  }
}

export class UnavailableSecretStore implements SecretStore {
  constructor(private readonly reason: string) {}

  availability(): Promise<SecretStoreAvailability> {
    return Promise.resolve({ available: false, persistent: false, reason: this.reason });
  }

  save(): Promise<void> { return Promise.reject(new SecretStoreUnavailableError(this.reason)); }
  read(): Promise<undefined> { return Promise.reject(new SecretStoreUnavailableError(this.reason)); }
  delete(): Promise<void> { return Promise.reject(new SecretStoreUnavailableError(this.reason)); }
}

export type CredentialCommandRunner = (encodedScript: string, stdin: string) => Promise<string>;

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$vault = New-Object Windows.Security.Credentials.PasswordVault
$resource = [string]$payload.resource
$username = [string]$payload.username
if ($payload.operation -eq 'save') {
  try { $existing = $vault.Retrieve($resource, $username); $vault.Remove($existing) } catch {}
  $credential = New-Object Windows.Security.Credentials.PasswordCredential($resource, $username, [string]$payload.secret)
  $vault.Add($credential)
  '{"ok":true}'
} elseif ($payload.operation -eq 'read') {
  try {
    $credential = $vault.Retrieve($resource, $username)
    $credential.RetrievePassword()
    @{ found = $true; secret = $credential.Password } | ConvertTo-Json -Compress
  } catch {
    '{"found":false}'
  }
} elseif ($payload.operation -eq 'delete') {
  try { $credential = $vault.Retrieve($resource, $username); $vault.Remove($credential) } catch {}
  '{"ok":true}'
} else { throw 'Unsupported operation' }
`;

function defaultCredentialRunner(encodedScript: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new SecretStoreUnavailableError(`Windows Credential Manager command failed (${String(code)}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
    child.stdin.end(stdin);
  });
}

interface CredentialResult { readonly ok?: boolean; readonly found?: boolean; readonly secret?: string }

export class WindowsCredentialManagerSecretStore implements SecretStore {
  readonly #encodedScript = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");

  constructor(
    private readonly runner: CredentialCommandRunner = defaultCredentialRunner,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  availability(): Promise<SecretStoreAvailability> {
    return Promise.resolve(this.platform === "win32"
      ? { available: true, persistent: true }
      : { available: false, persistent: false, reason: "Windows Credential Manager is only available on Windows" });
  }

  async save(reference: SecretReference, secret: string): Promise<void> {
    this.#assertWindows();
    if (secret.length === 0) throw new Error("secret must not be empty");
    await this.#run({ operation: "save", resource: `${RESOURCE_PREFIX}${reference}`, username: String(reference), secret });
  }

  async read(reference: SecretReference): Promise<string | undefined> {
    this.#assertWindows();
    const result = await this.#run({ operation: "read", resource: `${RESOURCE_PREFIX}${reference}`, username: String(reference) });
    return result.found === true ? result.secret : undefined;
  }

  async delete(reference: SecretReference): Promise<void> {
    this.#assertWindows();
    await this.#run({ operation: "delete", resource: `${RESOURCE_PREFIX}${reference}`, username: String(reference) });
  }

  #assertWindows(): void {
    if (this.platform !== "win32") throw new SecretStoreUnavailableError("Windows Credential Manager is only available on Windows");
  }

  async #run(payload: Readonly<Record<string, string>>): Promise<CredentialResult> {
    const raw = await this.runner(this.#encodedScript, JSON.stringify(payload));
    try {
      return JSON.parse(raw) as CredentialResult;
    } catch {
      throw new SecretStoreUnavailableError("Windows Credential Manager returned an invalid response");
    }
  }
}

export function createPlatformSecretStore(options: {
  readonly platform?: NodeJS.Platform;
  readonly testFallback?: boolean;
  readonly runner?: CredentialCommandRunner;
} = {}): SecretStore {
  const platform = options.platform ?? process.platform;
  if (options.testFallback === true) return new InMemorySecretStore();
  if (platform === "win32") return new WindowsCredentialManagerSecretStore(options.runner, platform);
  return new UnavailableSecretStore("Persistent connector secrets require Windows Credential Manager");
}
