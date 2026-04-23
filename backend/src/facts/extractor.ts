import { logger } from "../observability/logger.js";
import { routeLlmCall } from "../llm/router.js";
import { upsertFact } from "../db/repos/subscriber_facts.js";
import { loadRecentInbound } from "../db/repos/messages.js";
import { z } from "zod";

const factSchema = z.object({
  key: z.string().min(1).max(64),
  value: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});

const factsSchema = z.object({
  facts: z.array(factSchema).max(10).default([]),
});

export type ExtractedFact = z.infer<typeof factSchema>;

/**
 * Extract durable facts from a fan's recent messages. Cheap CLASSIFY-tier
 * call. Merges facts supplied by the generator (already parsed from the main
 * LLM output) with anything the extractor finds. Writes all of them to
 * v3.subscriber_facts with supersession.
 *
 * Pulls a small window of the fan's last N inbound messages so a fact split
 * across two turns ("i have a dog" / "his name is claude") can be joined —
 * neither message alone contains the whole fact.
 *
 * Fact keys are free-form; canonical ones we favour:
 *   location, timezone, preference, turn_off, occupation, birthday,
 *   relationship_status, kink, name_given, pet_name, family_member,
 *   owns_thing, hobby, goal
 */
export async function extractAndPersistFacts(args: {
  subscriberId: string;
  conversationId?: string;
  sourceMessageId: string | null;
  inboundText: string;
  /** Facts the main generator suggested this turn — merged in. */
  suggestedFacts?: Array<{ key: string; value: string; confidence: number }>;
}): Promise<ExtractedFact[]> {
  const merged: ExtractedFact[] = [];

  // Pull the short window of recent inbound so the extractor can join facts
  // split across turns. Current burst text alone isn't enough — dog name
  // claude landed two turns after "i have a dog" in real traffic.
  let windowText = args.inboundText;
  if (args.conversationId) {
    try {
      const recent = await loadRecentInbound(args.conversationId, 6);
      if (recent.length > 1) {
        windowText = recent.map((m) => m.text).join("\n---\n");
      }
    } catch {
      // non-fatal; fall back to current turn only
    }
  }

  // LLM-extracted facts
  try {
    const systemPrompt = [
      `You extract durable facts about a fan from their recent messages.`,
      `Only extract things that will still be true in a week or more: preferences, location, timezone, job, relationship status, kinks, things they dislike, their given name, pet names, family members, things they own (car, home, etc), hobbies, goals.`,
      `Join information across multiple messages when they combine into one fact: e.g. "i have a dog" + "his name is claude" → {"key":"pet_name","value":"claude (dog)"}.`,
      `Ignore moods, ephemeral statements ("i'm bored", "just had coffee"), and anything the messages don't actually say.`,
      `Return JSON: {"facts":[{"key":"pet_name","value":"claude (golden retriever)","confidence":0.9}]}. No prose, no code fences.`,
    ].join(" ");
    const userPrompt = `Recent messages from the fan (oldest first, separated by ---):\n"""\n${windowText}\n"""\n\nExtract facts.`;
    const result = await routeLlmCall({
      task: "EXTRACT",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      responseFormat: "json_object",
      temperature: 0.1,
      maxTokens: 300,
      meta: { subscriberId: args.subscriberId, sourceMessageId: args.sourceMessageId },
    });
    const raw = safeJson(result.content);
    if (raw.ok) {
      const validated = factsSchema.safeParse(raw.data);
      if (validated.success) merged.push(...validated.data.facts);
    }
  } catch (err) {
    logger.warn({ subscriberId: args.subscriberId, err: err instanceof Error ? err.message : err }, "fact extraction failed");
  }

  // Generator-suggested facts
  if (args.suggestedFacts) {
    for (const f of args.suggestedFacts) {
      const parsed = factSchema.safeParse(f);
      if (parsed.success) merged.push(parsed.data);
    }
  }

  // Deduplicate: same key keeps highest confidence
  const byKey = new Map<string, ExtractedFact>();
  for (const f of merged) {
    const prev = byKey.get(f.key);
    if (!prev || f.confidence > prev.confidence) byKey.set(f.key, f);
  }

  // Persist
  const persisted: ExtractedFact[] = [];
  for (const f of byKey.values()) {
    if (f.confidence < 0.5) continue; // don't persist low-confidence
    try {
      await upsertFact({
        subscriberId: args.subscriberId,
        key: f.key,
        value: f.value,
        confidence: f.confidence,
        sourceMessageId: args.sourceMessageId,
      });
      persisted.push(f);
    } catch (err) {
      logger.warn({ subscriberId: args.subscriberId, key: f.key, err: err instanceof Error ? err.message : err }, "fact upsert failed");
    }
  }

  if (persisted.length > 0) {
    logger.info({ subscriberId: args.subscriberId, count: persisted.length }, "facts extracted");
  }

  return persisted;
}

function safeJson(raw: string): { ok: true; data: unknown } | { ok: false } {
  const trimmed = raw.trim();
  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch {
    const m = /\{[\s\S]*\}/.exec(trimmed);
    if (!m) return { ok: false };
    try {
      return { ok: true, data: JSON.parse(m[0]) };
    } catch {
      return { ok: false };
    }
  }
}
