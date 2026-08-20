import { describe, expect, it } from "vitest";
import { hashPassword, hashToken, verifyPassword } from "@agent-voucher/access-workspace";

describe("password and token security", () => {
  it("stores a versioned scrypt hash and verifies in constant-time compatible form", async () => {
    const hash = await hashPassword("Foundation-Test-2026!");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(hash).not.toContain("Foundation-Test-2026!");
    await expect(verifyPassword("Foundation-Test-2026!", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("hashes session tokens before persistence", () => {
    expect(hashToken("session-secret")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken("session-secret")).not.toContain("session-secret");
  });
});
