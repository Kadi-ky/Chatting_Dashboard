import { logger } from "../observability/logger.js";
import { logLlmCall } from "../db/repos/llm_calls.js";
import { metrics } from "../observability/metrics.js";
import { CircuitBreaker } from "./circuit.js";
import { GrokProvider } from "./providers/grok.js";
import { OpenRouterProvider } from "./providers/openrouter.js";
import {
  LlmError,
  type LlmCallOptions,
  type LlmCallResult,
  type LlmProvider,
} from "./types.js";

const grok = new GrokProvider();
const openrouter = new OpenRouterProvider();

const grokBreaker = new CircuitBreaker("grok");
const openrouterBreaker = new CircuitBreaker("openrouter");

export interface RouterOptions {
  /** Number of retries on the primary before falling back. Default 2. */
  retries?: number;
  /** Base backoff in ms (exponential). Default 500. */
  backoffMs?: number;
}

/**
 * Task-aware LLM call with circuit breaker, retry, and fallback.
 * Every attempt (success or failure) is logged to v3.llm_calls.
 * The returned result includes llmCallId of the successful call, for threading
 * into messages.
 */
export async function routeLlmCall(
  opts: LlmCallOptions,
  routerOpts: RouterOptions = {},
): Promise<LlmCallResult> {
  // 2 → 3 retries, 500 → 250ms base backoff (2026-06-10 hardening): a failed
  // CHAT_GENERATE makes generateReply return null and the fan's message is
  // silently dropped (the turn "succeeds" with no outbound), so the router is
  // the layer that must absorb transient provider slowness. 4 attempts on the
  // primary at 250/500/1000ms spread fits inside the per-call 90s timeout
  // budget and the 300s turn hard-timeout.
  const retries = routerOpts.retries ?? 3;
  const backoffMs = routerOpts.backoffMs ?? 250;

  // 2026-06-02 — OpenRouter is PRIMARY (was grok). Grok-4.1-fast went
  // unavailable + too expensive; chat replies silently failed for ~a week
  // because the chat-generate path has no template fallback (unlike
  // nudges/vouchers). OpenRouter/Hermes-4-70b now serves all tasks; grok
  // is kept as a 1-shot last-resort only (fires only if OpenRouter is fully
  // down AND the grok key still works).
  const chain: Array<{ provider: LlmProvider; breaker: CircuitBreaker; attempts: number }> = [
    { provider: openrouter, breaker: openrouterBreaker, attempts: retries + 1 },
    { provider: grok, breaker: grokBreaker, attempts: 1 },
  ];

  let lastErr: Error | null = null;
  let providerIndex = -1;
  for (const { provider, breaker, attempts } of chain) {
    providerIndex += 1;
    if (providerIndex > 0) {
      metrics.llmFallbackInvoked.inc();
    }
    const model = provider.modelFor(opts.task);
    if (!model) continue;
    if (!breaker.canProceed()) {
      logger.warn({ provider: provider.name }, "circuit open — skipping");
      continue;
    }

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await provider.call(opts, model);
        breaker.recordSuccess();
        const logged = await logLlmCall({
          task: opts.task,
          provider: provider.name,
          model,
          ok: true,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          latencyMs: result.latencyMs,
          request: {
            messages: opts.messages,
            temperature: opts.temperature,
            responseFormat: opts.responseFormat,
            meta: opts.meta,
          },
          response: { content: result.content },
        });
        metrics.llmCallDuration.observe(result.latencyMs, {
          provider: provider.name,
          task: opts.task,
        });
        if (typeof result.costCents === "number") {
          metrics.llmCallCost.inc(result.costCents);
        }
        return { ...result, llmCallId: logged.id };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const isLlmError = err instanceof LlmError;
        const retriable = isLlmError ? err.retriable : true;
        breaker.recordFailure();
        await logLlmCall({
          task: opts.task,
          provider: provider.name,
          model,
          ok: false,
          error: lastErr.message,
          request: {
            messages: opts.messages,
            temperature: opts.temperature,
            responseFormat: opts.responseFormat,
            meta: opts.meta,
          },
        }).catch(() => undefined);
        logger.warn(
          { provider: provider.name, attempt, retriable, err: lastErr.message },
          "llm call failed",
        );
        if (!retriable || attempt === attempts - 1) break;
        await sleep(backoffMs * Math.pow(2, attempt));
      }
    }
  }

  throw lastErr ?? new Error("no LLM provider could handle the task");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
