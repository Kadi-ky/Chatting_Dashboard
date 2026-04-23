import { logger } from "../observability/logger.js";
import { routeLlmCall } from "../llm/router.js";
import { parseGeneratorOutput } from "../prompt/parse.js";
import { archetypeSchema, ARCHETYPE_OUTPUT_SPEC, CLASSIFIER_VERSION } from "./schema.js";
import { insertArchetype } from "../db/repos/archetypes.js";
import { loadRecentMessages } from "../db/repos/messages.js";
import type { ArchetypeOutput } from "./schema.js";

export type ClassifierDepth = "quick" | "full" | "partial";

export interface ClassifyArgs {
  subscriberId: string;
  conversationId: string;
  /** Controls how much history we feed in. */
  depth: ClassifierDepth;
  /** Optional short list of recent purchase/rejection events to prime the model. */
  events?: string[];
}

/**
 * Run the archetype classifier. Uses the classifier task path so Grok-4-fast
 * (or OpenRouter fallback) is chosen by the router. Failures are logged and
 * swallowed — classification is best-effort and never blocks the reply path.
 */
export async function classifyArchetype(args: ClassifyArgs): Promise<ArchetypeOutput | null> {
  const historyLimit = args.depth === "full" ? 40 : args.depth === "partial" ? 20 : 10;
  const history = await loadRecentMessages(args.conversationId, historyLimit);
  const transcript = history
    .filter((m) => typeof m.text === "string" && m.text.length > 0)
    .map((m) => `${m.direction === "inbound" ? "FAN" : "CREATOR"}: ${m.text}`)
    .join("\n");

  const eventsBlock = args.events && args.events.length > 0
    ? `\n\nRecent events:\n${args.events.map((e) => `- ${e}`).join("\n")}`
    : "";

  const systemPrompt = `You are a profile classifier for a disclosed-AI creator chat service. Analyze the conversation and emit a structured profile. Be decisive — low-confidence scores are acceptable, but every field must be filled. ${ARCHETYPE_OUTPUT_SPEC}`;

  const userPrompt = `Transcript (most recent last):\n${transcript}${eventsBlock}\n\nClassify this fan.`;

  try {
    const result = await routeLlmCall({
      task: "CLASSIFY",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      responseFormat: "json_object",
      temperature: 0.2,
      maxTokens: 600,
      meta: { subscriberId: args.subscriberId, depth: args.depth },
    });

    const parsed = parseGeneratorOutput(result.content);
    // parse.ts expects the generator schema; we need a separate path for archetype.
    // Just re-parse with our schema directly.
    const raw = parsed.raw ?? result.content;
    const jsonParse = safeJson(raw);
    if (!jsonParse.ok) {
      logger.warn({ subscriberId: args.subscriberId, err: jsonParse.error }, "archetype json parse failed");
      return null;
    }
    const validated = archetypeSchema.safeParse(jsonParse.data);
    if (!validated.success) {
      logger.warn({ subscriberId: args.subscriberId, err: validated.error.message }, "archetype schema validation failed");
      return null;
    }

    await insertArchetype({
      subscriberId: args.subscriberId,
      classifierVersion: `${CLASSIFIER_VERSION}-${args.depth}`,
      output: validated.data,
      raw: jsonParse.data as Record<string, unknown>,
    });

    logger.info(
      { subscriberId: args.subscriberId, depth: args.depth, tier: validated.data.spenderTier },
      "archetype classified",
    );
    return validated.data;
  } catch (err) {
    logger.warn({ subscriberId: args.subscriberId, err: err instanceof Error ? err.message : err }, "archetype classification failed");
    return null;
  }
}

function safeJson(raw: string): { ok: true; data: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch {
    const m = /\{[\s\S]*\}/.exec(trimmed);
    if (!m) return { ok: false, error: "no JSON object" };
    try {
      return { ok: true, data: JSON.parse(m[0]) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
