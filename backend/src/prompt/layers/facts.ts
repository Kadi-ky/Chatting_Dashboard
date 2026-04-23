import type { FactRow } from "../../db/repos/subscriber_facts.js";

/**
 * L6 — FACTS selection. Top-k relevant facts for this turn. v1 uses a simple
 * keyword overlap score against the inbound message; v2 can swap to
 * embeddings. Kept deterministic and dependency-free on purpose.
 */
export function pickRelevantFacts(args: {
  facts: FactRow[];
  inboundText: string;
  k?: number;
}): string[] {
  const k = args.k ?? 5;
  if (args.facts.length === 0) return [];

  const tokens = tokenize(args.inboundText);
  const scored = args.facts.map((f) => {
    let overlap = 0;
    for (const t of tokenize(`${f.key} ${f.value}`)) {
      if (tokens.has(t)) overlap += 1;
    }
    // Slight freshness bonus
    const daysOld = Math.max(0, (Date.now() - f.createdAt.getTime()) / 86_400_000);
    const freshness = 1 / (1 + daysOld / 30);
    return {
      fact: f,
      score: overlap * 2 + freshness + f.confidence,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, k).map((s) => `${s.fact.key}: ${s.fact.value}`);
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}
