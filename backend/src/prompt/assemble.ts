import type { LlmMessage } from "../llm/types.js";
import { loadIdentityLayer } from "./layers/identity.js";
import { CONTRACT_LAYER, CONTRACT_VERSION } from "./layers/contract.js";
import { HUMANNESS_LAYER, HUMANNESS_VERSION } from "./layers/humanness.js";
import { buildContextMessages, type ContextMessage } from "./layers/context.js";
import { buildTaskLayer, type TaskLayerInput } from "./layers/task.js";

export interface AssemblePromptInput {
  accountId: string;
  history: ContextMessage[];
  task: TaskLayerInput;
  /** Per-turn state directive (L4). Optional until the state machine ships. */
  stateDirective?: string;
  /** Per-turn archetype directive (L5). Optional until the classifier ships. */
  archetypeDirective?: string;
  /** Top-k relevant facts (L6). Pre-filtered by caller. */
  facts?: string[];
  /** Rolling window size for context; callers may widen for WHALE. */
  contextWindow?: number;
}

export interface AssembledPrompt {
  messages: LlmMessage[];
  /** Layer versions captured for audit + cache-busting. */
  versions: {
    contract: string;
    humanness: string;
  };
}

/**
 * Layered prompt assembly. Cached prefix (L1 identity, L2 contract, L3 humanness)
 * is emitted as the first system message so provider-level caching can hit it.
 * Volatile layers (state, archetype, facts, context, task) follow as separate
 * messages so they don't invalidate the cache on the prefix.
 */
export function assemblePrompt(input: AssemblePromptInput): AssembledPrompt {
  const identity = loadIdentityLayer(input.accountId);

  const prefix = [
    `# Identity`,
    identity,
    ``,
    `# Contract (v${CONTRACT_VERSION})`,
    CONTRACT_LAYER,
    ``,
    `# Humanness (v${HUMANNESS_VERSION})`,
    HUMANNESS_LAYER,
  ].join("\n");

  const messages: LlmMessage[] = [{ role: "system", content: prefix }];

  if (input.stateDirective && input.stateDirective.trim().length > 0) {
    messages.push({ role: "system", content: `# State\n${input.stateDirective.trim()}` });
  }

  if (input.archetypeDirective && input.archetypeDirective.trim().length > 0) {
    messages.push({ role: "system", content: `# Archetype\n${input.archetypeDirective.trim()}` });
  }

  if (input.facts && input.facts.length > 0) {
    messages.push({
      role: "system",
      content: `# Known facts about this fan\n${input.facts.map((f) => `- ${f}`).join("\n")}`,
    });
  }

  messages.push(...buildContextMessages(input.history, { windowSize: input.contextWindow ?? 12 }));

  messages.push({ role: "system", content: buildTaskLayer(input.task) });

  return {
    messages,
    versions: { contract: CONTRACT_VERSION, humanness: HUMANNESS_VERSION },
  };
}
