export type LlmTask = "CHAT_GENERATE" | "CLASSIFY" | "EXTRACT" | "MODERATE";

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmCallOptions {
  task: LlmTask;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** When set, instructs the provider to emit a JSON object. Caller must still validate. */
  responseFormat?: "text" | "json_object";
  stopSequences?: string[];
  /** Audit context attached to the llm_calls row (conversation_id, subscriber_id, etc.). */
  meta?: Record<string, unknown>;
}

export type LlmProviderName = "grok" | "openrouter";

export interface LlmCallResult {
  provider: LlmProviderName;
  model: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** Optional — providers may not return cost. */
  costCents?: number;
  /** ID of the row in v3.llm_calls, for threading back into messages. */
  llmCallId?: string;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  /** Mapping of task → model name for this provider. Missing = not supported for that task. */
  modelFor(task: LlmTask): string | null;
  call(opts: LlmCallOptions, model: string): Promise<LlmCallResult>;
}

export class LlmError extends Error {
  constructor(
    public readonly provider: LlmProviderName,
    public readonly status: number | null,
    message: string,
    public readonly retriable: boolean = true,
  ) {
    super(`${provider} ${status ?? "net"}: ${message}`);
    this.name = "LlmError";
  }
}
