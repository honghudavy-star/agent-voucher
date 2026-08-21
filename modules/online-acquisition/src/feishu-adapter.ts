import {
  ApprovalDetailApiResponseSchema,
  AttachmentDownloadRequestSchema,
  DiscoveryRequestSchema,
  InstanceDetailApiResponseSchema,
  InstanceIdPageApiResponseSchema,
  TenantTokenApiResponseSchema,
} from "./schemas.js";
import type { ConnectorAdapter, SecretStore } from "./contracts.js";
import {
  FEISHU_INSTANCE_STATUS,
  FEISHU_PLATFORM,
  asApprovalCode,
  type AttachmentDownloadRequest,
  type ConnectionTestResult,
  type ConnectorFailure,
  type DiscoveryPage,
  type DiscoveryRequest,
  type FeishuConnectionConfig,
  type FeishuInstance,
  type InstanceCode,
  type ReconciliationResult,
  type RemoteAttachment,
} from "./types.js";

export const FEISHU_OPEN_PLATFORM_ORIGIN = "https://open.feishu.cn";
export const LARK_OPEN_PLATFORM_ORIGIN = "https://open.larksuite.com";
const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const AUTH_ERROR_CODES = new Set([99991663, 99991664, 99991668, 99991669]);

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ConnectorRequestError extends Error {
  constructor(message: string, readonly failure: ConnectorFailure, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectorRequestError";
  }
}

export function classifyConnectorFailure(input: {
  readonly status?: number;
  readonly apiCode?: number;
  readonly retryAfter?: string | null;
  readonly cause?: unknown;
  readonly code?: string;
}): ConnectorFailure {
  if (input.status === 401 || input.status === 403 || (input.apiCode !== undefined && AUTH_ERROR_CODES.has(input.apiCode))) {
    return { category: "REAUTH_REQUIRED", code: input.code ?? `FEISHU_AUTH_${String(input.apiCode ?? input.status)}`, retryable: false };
  }
  if (input.status === 429) {
    return { category: "RATE_LIMITED", code: input.code ?? "FEISHU_RATE_LIMITED", retryable: true, retryAfterMs: parseRetryAfter(input.retryAfter) };
  }
  if (input.status !== undefined && input.status >= 500) {
    return { category: "TRANSIENT", code: input.code ?? `FEISHU_HTTP_${String(input.status)}`, retryable: true };
  }
  if (input.cause instanceof TypeError || (input.cause instanceof Error && input.cause.name === "AbortError")) {
    return { category: "TRANSIENT", code: input.code ?? "FEISHU_NETWORK", retryable: true };
  }
  return { category: "PERMANENT", code: input.code ?? `FEISHU_${String(input.apiCode ?? input.status ?? "INVALID_RESPONSE")}`, retryable: false };
}

function parseRetryAfter(value: string | null | undefined): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : 1_000;
}

function mapInstance(value: ReturnType<typeof InstanceDetailApiResponseSchema.parse>["data"]): FeishuInstance {
  if (!value) throw new ConnectorRequestError("Feishu response omitted instance data", classifyConnectorFailure({ code: "FEISHU_MISSING_DATA" }));
  return {
    instanceCode: value.instance_code,
    approvalCode: value.approval_code,
    status: value.status,
    startTime: value.start_time,
    ...(value.end_time === undefined ? {} : { endTime: value.end_time }),
    ...(value.serial_number === undefined ? {} : { serialNumber: value.serial_number }),
    form: value.form,
    taskList: value.task_list,
    commentList: value.comment_list,
    timeline: value.timeline,
    ...(value.modified_instance_code === undefined ? {} : { modifiedInstanceCode: value.modified_instance_code }),
    ...(value.reverted_instance_code === undefined ? {} : { revertedInstanceCode: value.reverted_instance_code }),
    reverted: value.reverted,
  };
}

export class FeishuConnectorAdapter implements ConnectorAdapter {
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #signal: AbortSignal | undefined;
  #cachedToken: { readonly value: string; readonly expiresAt: number } | undefined;
  #tokenRefresh: Promise<string> | undefined;
  #disabled = false;
  readonly #origin: string;

  constructor(
    private readonly config: FeishuConnectionConfig,
    private readonly secretStore: SecretStore,
    options: { readonly fetch?: FetchLike; readonly now?: () => number; readonly signal?: AbortSignal } = {},
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#signal = options.signal;
    this.#origin = config.platform === FEISHU_PLATFORM.LARK ? LARK_OPEN_PLATFORM_ORIGIN : FEISHU_OPEN_PLATFORM_ORIGIN;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const approvalCode = this.config.approvalCodes[0];
    if (!approvalCode) throw new ConnectorRequestError("At least one approval code is required", classifyConnectorFailure({ code: "FEISHU_CONFIG_INVALID" }));
    const response = await this.#requestJson(`/open-apis/approval/v4/approvals/${encodeURIComponent(approvalCode)}`, { method: "GET" });
    const parsed = ApprovalDetailApiResponseSchema.parse(response);
    this.#assertApiSuccess(parsed.code, parsed.msg, parsed.data);
    return { ok: true, checkedApprovalCode: approvalCode };
  }

  async discoverApproved(request: DiscoveryRequest): Promise<DiscoveryPage> {
    const input = DiscoveryRequestSchema.parse(request);
    if (!this.config.approvalCodes.includes(input.approvalCode)) {
      throw new ConnectorRequestError("Approval code is not whitelisted", classifyConnectorFailure({ code: "FEISHU_APPROVAL_NOT_ALLOWED" }));
    }
    const query = new URLSearchParams({ page_size: String(input.pageSize) });
    if (input.pageToken !== undefined) query.set("page_token", input.pageToken);
    const raw = await this.#requestJson(`/open-apis/approval/v4/instances/query?${query.toString()}`, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        approval_code: input.approvalCode, instance_status: FEISHU_INSTANCE_STATUS.APPROVED,
        instance_start_time_from: input.startTime, instance_start_time_to: input.endTime,
      }),
    });
    const page = InstanceIdPageApiResponseSchema.parse(raw);
    this.#assertApiSuccess(page.code, page.msg, page.data);
    const codes = [...new Set([...(page.data?.instance_code_list ?? []), ...(page.data?.instance_list ?? []).map((item) => item.instance.code)])];
    const details = await Promise.all(codes.map(async (code) => this.#getInstance(code)));
    const approved = details.filter((item) => item.status === FEISHU_INSTANCE_STATUS.APPROVED);
    return {
      items: approved,
      hasMore: page.data?.has_more ?? false,
      ...(page.data?.page_token === undefined ? {} : { nextPageToken: page.data.page_token }),
      observedInstanceCodes: codes,
    };
  }

  async reconcileTrackedInstances(instanceCodes: readonly InstanceCode[]): Promise<readonly ReconciliationResult[]> {
    const results: ReconciliationResult[] = [];
    for (const instanceCode of [...new Set(instanceCodes)]) {
      try {
        const instance = await this.#getInstance(instanceCode);
        const effectiveStatus = instance.reverted ? FEISHU_INSTANCE_STATUS.REVERTED : instance.status;
        results.push({
          instanceCode,
          status: effectiveStatus,
          instance,
          tombstone: instance.status === FEISHU_INSTANCE_STATUS.CANCELED
            || instance.status === FEISHU_INSTANCE_STATUS.DELETED
            || instance.status === FEISHU_INSTANCE_STATUS.REVERTED
            || instance.reverted,
        });
      } catch (error) {
        if (error instanceof ConnectorRequestError && error.failure.category === "PERMANENT" && error.failure.code === "FEISHU_HTTP_404") {
          results.push({ instanceCode, status: FEISHU_INSTANCE_STATUS.DELETED, tombstone: true });
        } else {
          throw error;
        }
      }
    }
    return results;
  }

  async downloadAttachment(request: AttachmentDownloadRequest): Promise<RemoteAttachment> {
    const { remotePath } = AttachmentDownloadRequestSchema.parse(request);
    const url = this.#attachmentUrl(remotePath);
    const response = url.origin === this.#origin
      ? await this.#request(url, { method: "GET", redirect: "manual" }, false)
      : await this.#requestSignedAttachment(url);
    if (!response.body) throw new ConnectorRequestError("Feishu attachment response had no body", classifyConnectorFailure({ code: "FEISHU_EMPTY_ATTACHMENT" }));
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
    const disposition = response.headers.get("content-disposition");
    const suggestedFilename = disposition === null ? undefined : parseContentDispositionFilename(disposition);
    return {
      stream: response.body,
      mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream",
      ...(Number.isSafeInteger(contentLength) && contentLength !== undefined && contentLength >= 0 ? { contentLength } : {}),
      ...(suggestedFilename === undefined ? {} : { suggestedFilename }),
    };
  }

  disable(): Promise<void> {
    this.#disabled = true;
    this.#cachedToken = undefined;
    this.#tokenRefresh = undefined;
    return Promise.resolve();
  }

  async #getInstance(instanceCode: InstanceCode): Promise<FeishuInstance> {
    const raw = await this.#requestJson(`/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}`, { method: "GET" });
    const detail = InstanceDetailApiResponseSchema.parse(raw);
    this.#assertApiSuccess(detail.code, detail.msg, detail.data);
    return mapInstance(detail.data);
  }

  async #getToken(): Promise<string> {
    this.#assertEnabled();
    if (this.#cachedToken && this.#cachedToken.expiresAt > this.#now()) return this.#cachedToken.value;
    if (this.#tokenRefresh) return this.#tokenRefresh;
    this.#tokenRefresh = this.#refreshToken();
    try {
      return await this.#tokenRefresh;
    } finally {
      this.#tokenRefresh = undefined;
    }
  }

  async #refreshToken(): Promise<string> {
    const appSecret = await this.secretStore.read(this.config.secretReference);
    if (!appSecret) throw new ConnectorRequestError("Feishu app secret is unavailable", classifyConnectorFailure({ status: 401, code: "FEISHU_SECRET_MISSING" }));
    const response = await this.#request(TOKEN_PATH, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: appSecret }),
    }, true);
    const raw: unknown = await response.json();
    const parsed = TenantTokenApiResponseSchema.parse(raw);
    this.#assertApiSuccess(parsed.code, parsed.msg, parsed.tenant_access_token);
    if (!parsed.tenant_access_token || !parsed.expire) {
      throw new ConnectorRequestError("Feishu token response omitted credentials", classifyConnectorFailure({ code: "FEISHU_TOKEN_INVALID" }));
    }
    const safeLifetimeMs = Math.max(1_000, parsed.expire * 1_000 - 60_000);
    this.#cachedToken = { value: parsed.tenant_access_token, expiresAt: this.#now() + safeLifetimeMs };
    return parsed.tenant_access_token;
  }

  async #requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#request(path, init, false);
    try {
      return await response.json() as unknown;
    } catch (cause) {
      throw new ConnectorRequestError("Feishu returned invalid JSON", classifyConnectorFailure({ cause, code: "FEISHU_INVALID_JSON" }), { cause });
    }
  }

  async #request(path: string | URL, init: RequestInit, anonymous: boolean): Promise<Response> {
    this.#assertEnabled();
    const url = path instanceof URL ? path : this.#fixedUrl(path);
    const headers = new Headers(init.headers);
    if (!anonymous) headers.set("authorization", `Bearer ${await this.#getToken()}`);
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(60_000);
      const signal = this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout;
      response = await this.#fetch(url, { ...init, redirect: "manual", headers, signal });
    } catch (cause) {
      throw new ConnectorRequestError("Feishu network request failed", classifyConnectorFailure({ cause }), { cause });
    }
    if (!response.ok) {
      const failure = classifyConnectorFailure({
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        code: `FEISHU_HTTP_${String(response.status)}`,
      });
      throw new ConnectorRequestError(`Feishu HTTP request failed (${String(response.status)})`, failure);
    }
    return response;
  }

  #fixedUrl(path: string): URL {
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin) {
      throw new ConnectorRequestError("Refused non-Feishu URL", classifyConnectorFailure({ code: "FEISHU_UNSAFE_URL" }));
    }
    return url;
  }

  #attachmentUrl(remotePath: string): URL {
    if (remotePath.startsWith("/")) return this.#fixedUrl(remotePath);
    const url = new URL(remotePath);
    if (!isTrustedAttachmentHost(url)) {
      throw new ConnectorRequestError("Refused untrusted attachment URL", classifyConnectorFailure({ code: "FEISHU_UNSAFE_ATTACHMENT_URL" }));
    }
    return url;
  }

  async #requestSignedAttachment(initialUrl: URL): Promise<Response> {
    let url = initialUrl;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(60_000);
        const signal = this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout;
        response = await this.#fetch(url, { method: "GET", redirect: "manual", signal });
      } catch (cause) {
        throw new ConnectorRequestError("Feishu attachment request failed", classifyConnectorFailure({ cause }), { cause });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === 3) throw new ConnectorRequestError("Feishu attachment redirect failed", classifyConnectorFailure({ status: response.status }));
        const next = new URL(location, url);
        if (!isTrustedAttachmentHost(next)) throw new ConnectorRequestError("Refused untrusted attachment redirect", classifyConnectorFailure({ code: "FEISHU_UNSAFE_ATTACHMENT_REDIRECT" }));
        url = next; continue;
      }
      if (!response.ok) throw new ConnectorRequestError(`Feishu attachment HTTP request failed (${String(response.status)})`, classifyConnectorFailure({
        status: response.status, retryAfter: response.headers.get("retry-after"), code: `FEISHU_HTTP_${String(response.status)}`,
      }));
      return response;
    }
    throw new ConnectorRequestError("Feishu attachment redirect limit exceeded", classifyConnectorFailure({ code: "FEISHU_ATTACHMENT_REDIRECT_LIMIT" }));
  }

  #assertApiSuccess(code: number, message: string, data: unknown): void {
    if (code === 0 && data !== undefined) return;
    const failure = classifyConnectorFailure({ apiCode: code, code: `FEISHU_API_${String(code)}` });
    throw new ConnectorRequestError(`Feishu API request failed: ${message || String(code)}`, failure);
  }

  #assertEnabled(): void {
    if (this.#disabled) throw new ConnectorRequestError("Connector is disabled", classifyConnectorFailure({ code: "CONNECTOR_DISABLED" }));
  }
}

function parseContentDispositionFilename(value: string): string | undefined {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8); } catch { return undefined; }
  }
  return /filename="?([^";]+)"?/i.exec(value)?.[1];
}

function isTrustedAttachmentHost(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "") return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === "open.feishu.cn" || hostname === "open.larksuite.com"
    || hostname.endsWith(".feishucdn.com") || hostname.endsWith(".larksuitecdn.com");
}

export function createTestFeishuConfig(overrides: Partial<FeishuConnectionConfig> = {}): FeishuConnectionConfig {
  return {
    connectorId: "feishu-default" as FeishuConnectionConfig["connectorId"],
    displayName: "飞书审批",
    platform: FEISHU_PLATFORM.FEISHU,
    appId: "cli_test",
    secretReference: "feishu-default" as FeishuConnectionConfig["secretReference"],
    approvalCodes: [asApprovalCode("APPROVAL_1")],
    attachmentControlIds: {},
    initialLookbackFrom: "2026-01-01T00:00:00.000Z",
    dailySyncTime: "02:00",
    timeZone: "Asia/Shanghai",
    overlapHours: 48,
    revision: 1,
    status: "ACTIVE",
    ...overrides,
  };
}
