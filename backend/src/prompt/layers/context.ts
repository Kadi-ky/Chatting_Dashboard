import type { LlmMessage } from "../../llm/types.js";

export type MessageDirection = "inbound" | "outbound";

export interface ContextMessage {
  direction: MessageDirection;
  text: string;
  createdAt: Date;
  /** Optional — if the message carried media, note that so the model doesn't forget. */
  mediaHint?: string;
}

export interface BuildContextOptions {
  /** Rolling window size. Default 12; callers may widen for WHALE. */
  windowSize?: number;
  /** If true, prepend a one-line header framing this as chat history. */
  header?: boolean;
}

/**
 * L7 — CONTEXT. Returns LlmMessage[] shaped as alternating user/assistant turns
 * so the model treats the chat as a real dialogue rather than a block of text.
 * Older messages beyond the window are dropped; callers are responsible for
 * summarising those into facts (L6) before they fall off.
 */
export function buildContextMessages(
  history: ContextMessage[],
  opts: BuildContextOptions = {},
): LlmMessage[] {
  const windowSize = opts.windowSize ?? 12;
  const trimmed = history.slice(-windowSize);
  if (trimmed.length === 0) return [];

  const out: LlmMessage[] = [];
  if (opts.header) {
    out.push({
      role: "system",
      content: "The following is the recent chat history with this fan, oldest first.",
    });
  }

  for (const m of trimmed) {
    const content = m.mediaHint ? `${m.text}\n[attached: ${m.mediaHint}]` : m.text;
    out.push({
      role: m.direction === "inbound" ? "user" : "assistant",
      content,
    });
  }
  return out;
}
