import { env } from "../../../config/index.js";
import { logger } from "../../../observability/logger.js";

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class PlatformHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`platform ${status} ${path}: ${body.slice(0, 200)}`);
    this.name = "PlatformHttpError";
  }
}

export class PlatformHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    const resolvedBase = baseUrl ?? env.PLATFORM_API_BASE;
    const resolvedKey = apiKey ?? env.PLATFORM_API_KEY;
    if (!resolvedBase || !resolvedKey) {
      throw new Error(
        "PlatformHttpClient requires PLATFORM_API_BASE and PLATFORM_API_KEY (or PLATFORM_MODE=mock)",
      );
    }
    this.baseUrl = resolvedBase;
    this.apiKey = resolvedKey;
  }

  async request<T>(path: string, opts: HttpRequestOptions = {}): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const started = Date.now();
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;

    const res = await fetch(url, init);

    const elapsed = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn({ path, status: res.status, elapsed }, "platform http error");
      throw new PlatformHttpError(res.status, path, text);
    }

    logger.debug({ path, status: res.status, elapsed }, "platform http ok");

    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }
}
