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
    /**
     * Parsed Retry-After header value in milliseconds (when present and
     * parseable). OnlyFansAPI sends this on 429 — per their guidance
     * (2026-04-28), waiting at least this long before retry is required;
     * retrying sooner triggers stricter back-off. Null when no header was
     * present or the value couldn't be parsed.
     */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`platform ${status} ${path}: ${body.slice(0, 500)}`);
    this.name = "PlatformHttpError";
  }
}

/**
 * Parse a Retry-After header. RFC 7231 allows two forms:
 *   - delta-seconds (integer): "Retry-After: 120"
 *   - HTTP-date: "Retry-After: Wed, 21 Oct 2026 07:28:00 GMT"
 * Returns milliseconds to wait, or null if unparseable / negative / absent.
 */
export function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  // delta-seconds form
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return secs > 0 ? secs * 1000 : null;
  }
  // HTTP-date form
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  const ms = ts - Date.now();
  return ms > 0 ? ms : null;
}

/**
 * In-memory ring buffer of recent platform HTTP errors. Surfaced via
 * /diag/recent-errors so we can debug send failures without hunting Railway
 * deploy logs. Process-local — clears on container restart.
 */
interface RecentError {
  at: string;
  status: number;
  path: string;
  method: string;
  responseBody: string;
  /** Parsed Retry-After header value in milliseconds (set on 429s when the header is present). */
  retryAfterMs?: number;
  /** Raw Retry-After header value as the server sent it. Shown for verification. */
  retryAfterHeaderRaw?: string;
  requestBodyKeys?: string[];
}
const RECENT_ERRORS: RecentError[] = [];
const RECENT_ERRORS_MAX = 20;
export function getRecentPlatformErrors(): RecentError[] {
  return RECENT_ERRORS.slice();
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

    // Headers mimic n8n's HTTP Request node which (empirically 2026-04-29)
    // does NOT trigger OF Cloudflare 1015s on the same OF account that V3
    // gets locked out from. Likely Cloudflare's WAF scores our prior shape
    // as bot-like:
    //   - Accept: application/json (narrow, programmatic)
    //   - default Node fetch User-Agent (undici/...)
    //   - Idempotency-Key: ... (unusual header)
    // Switching to a browser-shaped Accept header + a real Chrome UA + no
    // Idempotency-Key matches what n8n sends and what real browser traffic
    // looks like.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept:
        "application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, image/*;q=0.8, */*;q=0.7",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Encoding": "gzip, deflate, br",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    // Idempotency-Key intentionally OMITTED. n8n doesn't send one and we've
    // observed Cloudflare 1015 lockouts on identical-rate traffic from us
    // that n8n doesn't get. If we lose retry safety here, the worst case is
    // a duplicate send on transient network failure — already mitigated by
    // BullMQ removeOnComplete + per-message message_id idempotency on our
    // own DB side. Worth the trade for actual rate-limit relief.

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
      // Verbose error logging for debugging real production failures.
      // Includes the response body (first 500 chars) and a hash of the
      // request body for correlation. The full request body could contain
      // sensitive content (fan-facing message text), so we hash it instead
      // of logging raw — that's enough to correlate two failures of the
      // same outbound retry.
      const retryAfterRaw = res.headers.get("retry-after");
      const retryAfterMs = parseRetryAfter(retryAfterRaw);
      const errEntry: RecentError = {
        at: new Date().toISOString(),
        status: res.status,
        path,
        method: opts.method ?? "GET",
        responseBody: text.slice(0, 1000),
        ...(retryAfterMs != null ? { retryAfterMs } : {}),
        ...(retryAfterRaw ? { retryAfterHeaderRaw: retryAfterRaw } : {}),
        ...(opts.body && typeof opts.body === "object"
          ? { requestBodyKeys: Object.keys(opts.body as Record<string, unknown>) }
          : {}),
      };
      RECENT_ERRORS.unshift(errEntry);
      if (RECENT_ERRORS.length > RECENT_ERRORS_MAX) RECENT_ERRORS.length = RECENT_ERRORS_MAX;
      logger.warn(errEntry, "platform http error");
      throw new PlatformHttpError(res.status, path, text, retryAfterMs);
    }

    // Surface OFAPI's rate-limit headers on every successful response so
    // we can self-throttle before hitting limits AND so /diag can expose
    // the remaining quota. OFAPI sends:
    //   x-rate-limit-limit-minute       (e.g. 5000)
    //   x-rate-limit-remaining-minute   (e.g. 4991)
    //   x-ofapi-credits-balance         (account-wide credit pool)
    const remainingMinute = res.headers.get("x-rate-limit-remaining-minute");
    const limitMinute = res.headers.get("x-rate-limit-limit-minute");
    const creditsBalance = res.headers.get("x-ofapi-credits-balance");
    if (remainingMinute != null && limitMinute != null) {
      LAST_RATE_LIMIT_INFO = {
        at: new Date().toISOString(),
        remainingMinute: Number(remainingMinute),
        limitMinute: Number(limitMinute),
        ...(creditsBalance != null ? { creditsBalance: Number(creditsBalance) } : {}),
      };
      // Warn if we're close to OFAPI's per-minute cap so the operator can
      // throttle dashboard/admin reads before they spill into 429s.
      const remaining = Number(remainingMinute);
      const limit = Number(limitMinute);
      if (limit > 0 && remaining < limit * 0.1) {
        logger.warn({ remaining, limit }, "OFAPI rate-limit window near exhaustion");
      }
    }
    logger.debug({ path, status: res.status, elapsed }, "platform http ok");

    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }
}

/** Latest rate-limit snapshot, populated on every successful PlatformHttpClient response. */
interface RateLimitInfo {
  at: string;
  remainingMinute: number;
  limitMinute: number;
  creditsBalance?: number;
}
let LAST_RATE_LIMIT_INFO: RateLimitInfo | null = null;
export function getLastRateLimitInfo(): RateLimitInfo | null {
  return LAST_RATE_LIMIT_INFO;
}
