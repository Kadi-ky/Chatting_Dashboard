import { env } from "../../config/index.js";
import {
  LlmError,
  type LlmCallOptions,
  type LlmCallResult,
  type LlmProvider,
  type LlmTask,
} from "../types.js";

interface GrokResponse {
  choices: Array<{ message: { content: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class GrokProvider implements LlmProvider {
  readonly name = "grok" as const;

  modelFor(task: LlmTask): string | null {
    switch (task) {
      case "CHAT_GENERATE":
        return env.GROK_MODEL_GENERATOR;
      case "CLASSIFY":
      case "EXTRACT":
      case "MODERATE":
        return env.GROK_MODEL_CLASSIFIER;
    }
  }

  async call(opts: LlmCallOptions, model: string): Promise<LlmCallResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      temperature: opts.temperature ?? (opts.task === "CHAT_GENERATE" ? 0.9 : 0.2),
      max_tokens: opts.maxTokens ?? (opts.task === "CHAT_GENERATE" ? 500 : 1000),
    };
    if (opts.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }
    if (opts.stopSequences && opts.stopSequences.length > 0) {
      body.stop = opts.stopSequences;
    }

    // Hard timeout. Without this, a hung grok call blocks the turn worker
    // forever — every subsequent turn for that conversation queues up behind
    // it and BullMQ never recovers. Generator gets 90s, the cheaper classify
    // / extract / moderate calls get 30s. Router catches AbortError and treats
    // it as retriable so we fall through to openrouter.
    const timeoutMs = opts.task === "CHAT_GENERATE" ? 90_000 : 30_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${env.GROK_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GROK_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      const msg = aborted
        ? `request timed out after ${timeoutMs}ms`
        : err instanceof Error ? err.message : String(err);
      throw new LlmError("grok", null, msg, true);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retriable = res.status >= 500 || res.status === 429 || res.status === 408;
      throw new LlmError("grok", res.status, text.slice(0, 500), retriable);
    }

    const data = (await res.json()) as GrokResponse;
    const choice = data.choices[0];
    if (!choice) {
      throw new LlmError("grok", 200, "empty choices in response", false);
    }

    return {
      provider: "grok",
      model,
      content: choice.message.content,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
