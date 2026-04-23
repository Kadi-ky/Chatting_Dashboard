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
      });
    } catch (err) {
      throw new LlmError("grok", null, err instanceof Error ? err.message : String(err), true);
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
