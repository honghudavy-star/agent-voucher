import { describe, expect, it } from "vitest";
import { FEISHU_PLATFORM, asInstanceCode, asSecretReference } from "./types.js";
import { FeishuConnectorAdapter, classifyConnectorFailure, createTestFeishuConfig } from "./feishu-adapter.js";
import { InMemorySecretStore } from "./secret-store.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("FeishuConnectorAdapter", () => {
  it("caches the tenant token and returns only approved discoveries", async () => {
    const calls: URL[] = [];
    const secretStore = new InMemorySecretStore();
    const secretReference = asSecretReference("feishu:test");
    await secretStore.save(secretReference, "secret-value");
    const config = createTestFeishuConfig({ secretReference });
    const mockedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push(url);
      if (url.pathname.endsWith("/tenant_access_token/internal")) {
        return Promise.resolve(jsonResponse({ code: 0, msg: "success", tenant_access_token: "tenant-token", expire: 7200 }));
      }
      if (url.pathname.endsWith("/instances/query")) {
        expect(url.origin).toBe("https://open.feishu.cn");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toMatchObject({ approval_code: "APPROVAL_1", instance_status: "APPROVED" });
        return Promise.resolve(jsonResponse({ code: 0, msg: "success", data: {
          instance_list: [{ instance: { code: "I_APPROVED" } }, { instance: { code: "I_PENDING" } }], has_more: false,
        } }));
      }
      if (url.pathname.endsWith("I_APPROVED")) return Promise.resolve(jsonResponse(instanceResponse("I_APPROVED", "APPROVED")));
      if (url.pathname.endsWith("I_PENDING")) return Promise.resolve(jsonResponse(instanceResponse("I_PENDING", "PENDING")));
      throw new Error(`Unexpected URL: ${url.toString()}`);
    };
    const adapter = new FeishuConnectorAdapter(config, secretStore, { fetch: mockedFetch });

    const page = await adapter.discoverApproved({
      approvalCode: config.approvalCodes[0]!,
      startTime: "1722470400000",
      endTime: "1722556800000",
    });

    expect(page.items.map((item) => item.instanceCode)).toEqual(["I_APPROVED"]);
    expect(page.observedInstanceCodes).toEqual(["I_APPROVED", "I_PENDING"]);
    expect(calls.filter((url) => url.pathname.endsWith("/tenant_access_token/internal"))).toHaveLength(1);
    expect(calls.every((url) => url.origin === "https://open.feishu.cn")).toBe(true);
  });

  it("reconciles tracked canceled instances into tombstones", async () => {
    const secretStore = new InMemorySecretStore();
    const config = createTestFeishuConfig();
    await secretStore.save(config.secretReference, "secret-value");
    const mockedFetch = (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/tenant_access_token/internal")) {
        return Promise.resolve(jsonResponse({ code: 0, msg: "success", tenant_access_token: "token", expire: 7200 }));
      }
      return Promise.resolve(jsonResponse(instanceResponse("I_CANCELED", "CANCELED")));
    };
    const adapter = new FeishuConnectorAdapter(config, secretStore, { fetch: mockedFetch });

    await expect(adapter.reconcileTrackedInstances([asInstanceCode("I_CANCELED")])).resolves.toEqual([
      expect.objectContaining({ instanceCode: "I_CANCELED", status: "CANCELED", tombstone: true }),
    ]);
  });

  it("normalizes an approved-but-reverted instance into a REVERTED tombstone", async () => {
    const secretStore = new InMemorySecretStore(); const config = createTestFeishuConfig();
    await secretStore.save(config.secretReference, "secret-value");
    const adapter = new FeishuConnectorAdapter(config, secretStore, { fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/tenant_access_token/internal")) return Promise.resolve(jsonResponse({ code: 0, msg: "success", tenant_access_token: "token", expire: 7200 }));
      return Promise.resolve(jsonResponse(instanceResponse("I_REVERTED", "APPROVED", true)));
    } });
    await expect(adapter.reconcileTrackedInstances([asInstanceCode("I_REVERTED")])).resolves.toEqual([
      expect.objectContaining({ instanceCode: "I_REVERTED", status: "REVERTED", tombstone: true }),
    ]);
  });

  it("does not invoke fetch for an untrusted attachment URL", async () => {
    const secretStore = new InMemorySecretStore();
    const config = createTestFeishuConfig();
    await secretStore.save(config.secretReference, "secret-value");
    let called = false;
    const adapter = new FeishuConnectorAdapter(config, secretStore, {
      fetch: () => { called = true; return Promise.resolve(new Response()); },
    });

    await expect(adapter.downloadAttachment({ remotePath: "https://example.com/private" })).rejects.toThrow(/approved Feishu/);
    expect(called).toBe(false);
  });

  it("uses the Lark origin and streams signed CDN attachments without an authorization header", async () => {
    const secretStore = new InMemorySecretStore(); const config = createTestFeishuConfig({ platform: FEISHU_PLATFORM.LARK });
    await secretStore.save(config.secretReference, "secret-value"); const calls: Array<{ url: URL; authorization: string | null }> = [];
    const adapter = new FeishuConnectorAdapter(config, secretStore, { fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get("authorization") });
      if (url.pathname.endsWith("/tenant_access_token/internal")) return Promise.resolve(jsonResponse({ code: 0, msg: "success", tenant_access_token: "token", expire: 7200 }));
      if (url.pathname.endsWith("/instances/query")) return Promise.resolve(jsonResponse({ code: 0, msg: "success", data: { instance_list: [], has_more: false } }));
      if (url.hostname.endsWith(".larksuitecdn.com")) return Promise.resolve(new Response("attachment", { status: 200, headers: { "content-type": "application/pdf" } }));
      throw new Error(`Unexpected URL: ${url.toString()}`);
    } });
    await adapter.discoverApproved({ approvalCode: config.approvalCodes[0]!, startTime: "1722470400000", endTime: "1722556800000" });
    const attachment = await adapter.downloadAttachment({ remotePath: "https://lf16-approval-file-sign.larksuitecdn.com/signed-file" });
    expect(attachment.mediaType).toBe("application/pdf");
    expect(calls.find((call) => call.url.pathname.endsWith("/instances/query"))?.url.origin).toBe("https://open.larksuite.com");
    expect(calls.find((call) => call.url.hostname.endsWith(".larksuitecdn.com"))?.authorization).toBeNull();
  });

  it("classifies auth, rate limit, server and network failures", () => {
    expect(classifyConnectorFailure({ status: 401 }).category).toBe("REAUTH_REQUIRED");
    expect(classifyConnectorFailure({ status: 429, retryAfter: "2" })).toEqual({
      category: "RATE_LIMITED", code: "FEISHU_RATE_LIMITED", retryable: true, retryAfterMs: 2000,
    });
    expect(classifyConnectorFailure({ status: 503 }).category).toBe("TRANSIENT");
    expect(classifyConnectorFailure({ cause: new TypeError("network") }).category).toBe("TRANSIENT");
  });
});

function instanceResponse(instanceCode: string, status: "APPROVED" | "PENDING" | "CANCELED", reverted = false): unknown {
  return {
    code: 0,
    msg: "success",
    data: {
      instance_code: instanceCode,
      approval_code: "APPROVAL_1",
      status,
      start_time: "1722470400000",
      form: "[]",
      task_list: [],
      comment_list: [],
      timeline: [],
      reverted,
    },
  };
}
