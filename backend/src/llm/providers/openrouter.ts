import { env } from "../../config/index.js";
import {
  LlmError,
  type LlmCallOptions,
  type LlmCallResult,
  type LlmProvider,
  type LlmTask,
} from "../types.js";

interface OpenRouterResponse {
  choices: Array<{ message: { content: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter" as const;

  modelFor(task: LlmTask): string | null {
    if (!env.OPENROUTER_API_KEY) return null;
    switch (task) {
      case "CHAT_GENERATE":
        return env.OPENROUTER_CHAT_MODEL;
      case "CLASSIFY":
      case "EXTRACT":
      case "MODERATE":
        return env.OPENROUTER_CLASSIFY_MODEL;
      case "NUDGE_GENERATE":
        // Nudges use the generator model (Hermes-4-70b) so they stay
        // in-voice with chat replies.
        return env.OPENROUTER_CHAT_MODEL;
    }
  }

  async call(opts: LlmCallOptions, model: string): Promise<LlmCallResult> {
    if (!env.OPENROUTER_API_KEY) {
      throw new LlmError("openrouter", null, "OPENROUTER_API_KEY not configured", false);
    }

    const started = Date.now();
    const isCreative = opts.task === "CHAT_GENERATE" || opts.task === "NUDGE_GENERATE";
    const defaultTemp = isCreative ? 0.9 : 0.2;
    const defaultMaxTokens =
      opts.task === "CHAT_GENERATE" ? 500 : opts.task === "NUDGE_GENERATE" ? 250 : 1000;
    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      temperature: opts.temperature ?? defaultTemp,
      max_tokens: opts.maxTokens ?? defaultMaxTokens,
    };
    if (opts.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }
    if (opts.stopSequences && opts.stopSequences.length > 0) {
      body.stop = opts.stopSequences;
    }

    // Hard timeout — match the grok provider so a hung fallback can't lock
    // the worker either.
    const timeoutMs = opts.task === "CHAT_GENERATE" ? 90_000 : 30_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${env.OPENROUTER_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "HTTP-Referer": "https://peachbot.local",
          "X-Title": "PeachBot",
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      const msg = aborted
        ? `request timed out after ${timeoutMs}ms`
        : err instanceof Error ? err.message : String(err);
      throw new LlmError("openrouter", null, msg, true);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retriable = res.status >= 500 || res.status === 429 || res.status === 408;
      throw new LlmError("openrouter", res.status, text.slice(0, 500), retriable);
    }

    const data = (await res.json()) as OpenRouterResponse;
    const choice = data.choices[0];
    if (!choice) {
      throw new LlmError("openrouter", 200, "empty choices in response", false);
    }

    return {
      provider: "openrouter",
      model,
      content: choice.message.content,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
