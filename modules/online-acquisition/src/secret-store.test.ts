import { describe, expect, it } from "vitest";
import { asSecretReference } from "./types.js";
import {
  InMemorySecretStore,
  SecretStoreUnavailableError,
  WindowsCredentialManagerSecretStore,
  createPlatformSecretStore,
} from "./secret-store.js";

describe("secret stores", () => {
  it("supports an explicit non-persistent test fallback", async () => {
    const store = createPlatformSecretStore({ platform: "darwin", testFallback: true });
    const reference = asSecretReference("feishu:test");
    await store.save(reference, "secret");
    await expect(store.read(reference)).resolves.toBe("secret");
    await expect(store.availability()).resolves.toEqual({ available: true, persistent: false });
  });

  it("fails closed on unsupported production platforms", async () => {
    const store = createPlatformSecretStore({ platform: "linux" });
    await expect(store.read(asSecretReference("feishu:test"))).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });

  it("passes Windows Credential Manager payload through stdin", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const runner = (_script: string, stdin: string): Promise<string> => {
      const payload = JSON.parse(stdin) as Record<string, unknown>;
      payloads.push(payload);
      if (payload.operation === "read") return Promise.resolve(JSON.stringify({ found: true, secret: "retrieved-secret" }));
      return Promise.resolve(JSON.stringify({ ok: true }));
    };
    const store = new WindowsCredentialManagerSecretStore(runner, "win32");
    const reference = asSecretReference("feishu:primary");
    await store.save(reference, "stored-secret");
    await expect(store.read(reference)).resolves.toBe("retrieved-secret");
    await store.delete(reference);

    expect(payloads.map((item) => item.operation)).toEqual(["save", "read", "delete"]);
    expect(payloads[0]?.secret).toBe("stored-secret");
    expect(await store.availability()).toEqual({ available: true, persistent: true });
  });

  it("keeps the basic in-memory implementation isolated", async () => {
    const store = new InMemorySecretStore();
    const reference = asSecretReference("ref");
    await store.save(reference, "value");
    await store.delete(reference);
    await expect(store.read(reference)).resolves.toBeUndefined();
  });
});
