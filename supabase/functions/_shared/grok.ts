// Grok (xAI) client wrapper.
//
// xAI exposes an OpenAI-compatible chat completions endpoint at
// https://api.x.ai/v1/chat/completions. We call it with fetch directly
// so we don't pull in the openai npm package (Deno + esm.sh adds weight).
//
// Phase 1 surface: grokChat() only. No streaming.

const GROK_API_KEY = Deno.env.get("GROK_API_KEY")!;
const GROK_API_BASE = Deno.env.get("GROK_API_BASE") ?? "https://api.x.ai/v1";

export type GrokModel = "grok-4" | "grok-3-mini" | string;

export interface GrokMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface GrokChatOptions {
  model: GrokModel;
  system: string;
  messages: GrokMessage[];
  /** When true, instruct the model to return strict JSON. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface GrokChatResult {
  content: string;
  usage: { prompt: number; completion: number };
  model: string;
}

class GrokError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GrokError";
  }
}

const RETRY_DELAYS_MS = [500, 1500, 4000];

/**
 * Run a chat completion. Retries on 429 + 5xx with exponential backoff.
 * Throws GrokError on non-retryable failures and after retries exhaust.
 */
export async function grokChat(opts: GrokChatOptions): Promise<GrokChatResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      ...opts.messages,
    ],
    temperature: opts.temperature ?? 0.9,
    max_tokens: opts.maxTokens ?? 512,
  };
  if (opts.json) {
    body.response_format = { type: "json_object" };
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(`${GROK_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = await res.json();
        const choice = json?.choices?.[0];
        const content: string = choice?.message?.content ?? "";
        return {
          content,
          usage: {
            prompt: json?.usage?.prompt_tokens ?? 0,
            completion: json?.usage?.completion_tokens ?? 0,
          },
          model: json?.model ?? opts.model,
        };
      }

      // Retry on 429 / 5xx only
      if (res.status === 429 || res.status >= 500) {
        lastErr = new GrokError(res.status, await res.text());
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw lastErr;
      }

      // Non-retryable
      throw new GrokError(res.status, await res.text());
    } catch (err) {
      // Network error → retry
      if (!(err instanceof GrokError)) {
        lastErr = err;
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
      }
      throw err;
    }
  }

  throw lastErr ?? new Error("grokChat: exhausted retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
