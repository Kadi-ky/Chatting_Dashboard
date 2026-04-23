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
        return env.OPENROUTER_FALLBACK_MODEL;
      case "CLASSIFY":
      case "EXTRACT":
      case "MODERATE":
        return env.OPENROUTER_CLASSIFIER_FALLBACK_MODEL;
    }
  }

  async call(opts: LlmCallOptions, model: string): Promise<LlmCallResult> {
    if (!env.OPENROUTER_API_KEY) {
      throw new LlmError("openrouter", null, "OPENROUTER_API_KEY not configured", false);
    }

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
      });
    } catch (err) {
      throw new LlmError("openrouter", null, err instanceof Error ? err.message : String(err), true);
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
