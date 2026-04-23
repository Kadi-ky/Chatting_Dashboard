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
  const retries = routerOpts.retries ?? 2;
  const backoffMs = routerOpts.backoffMs ?? 500;

  const chain: Array<{ provider: LlmProvider; breaker: CircuitBreaker; attempts: number }> = [
    { provider: grok, breaker: grokBreaker, attempts: retries + 1 },
    { provider: openrouter, breaker: openrouterBreaker, attempts: 1 },
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
