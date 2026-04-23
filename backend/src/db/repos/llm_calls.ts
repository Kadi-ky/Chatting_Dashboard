import { db } from "../client.js";

export interface LogLlmCallArgs {
  task: string;
  provider: string;
  model: string;
  ok: boolean;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costCents?: number | string | null;
  latencyMs?: number | null;
  error?: string | null;
  request?: unknown;
  response?: unknown;
}

export async function logLlmCall(args: LogLlmCallArgs): Promise<{ id: string }> {
  const row = await db
    .insertInto("v3.llm_calls")
    .values({
      task: args.task,
      provider: args.provider,
      model: args.model,
      prompt_tokens: args.promptTokens ?? null,
      completion_tokens: args.completionTokens ?? null,
      cost_cents: args.costCents != null ? String(args.costCents) : null,
      latency_ms: args.latencyMs ?? null,
      ok: args.ok,
      error: args.error ?? null,
      ...(args.request !== undefined ? { request: JSON.stringify(args.request) } : {}),
      ...(args.response !== undefined ? { response: JSON.stringify(args.response) } : {}),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}
