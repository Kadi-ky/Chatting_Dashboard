import type { Phase, PhaseDirective } from "./types.js";

/**
 * L4 STATE layer content per phase. Short, imperative, no flowery prose — the
 * model is already thick with instructions from L1/L2/L3. This layer just
 * sets the goal for this turn.
 */
export const PHASE_DIRECTIVES: Record<Phase, PhaseDirective> = {
  WARMUP: {
    directive: "Phase: WARMUP. Goal: be warm, playful, slightly flirty. This is a real conversation, not an interview. Make statements and reactions more than questions. If he flirts or makes a move, match the energy — do not deflect to a neutral topic. Tease but do not mention price yet. You are allowed to initiate light flirtation yourself.",
    forbiddens: [
      "do not mention PPV, price, or paid content",
      "do not ask a question in more than 1 in every 4 turns",
      "do not pivot to a neutral topic after he flirts",
      "do not promise to send anything",
    ],
  },
  RAPPORT: {
    directive: "Phase: RAPPORT. Goal: build tension. He knows you a little now, so the vibe can get warmer, more flirty, more physical. Reference something he said earlier only if it lands naturally — not as a callback for its own sake. You can open sexy threads yourself here. No pitches yet, but the register is allowed to heat up.",
    forbiddens: [
      "do not pitch aggressively",
      "do not mention a specific price",
      "do not send more than 3 bubbles",
      "do not ask a question in more than 1 in every 4 turns",
      "do not deflect when he flirts — match or escalate",
    ],
  },
  QUALIFYING: {
    directive: "Phase: QUALIFYING. Goal: test price sensitivity. Ok to tease a specific thing you could send and mention a soft price if the moment is there. Read their reaction. One offer max this turn.",
    forbiddens: [
      "do not pitch more than one asset in this turn",
      "do not pressure them if they object",
      "do not lie about the content",
    ],
  },
  MONETIZING: {
    directive: "Phase: MONETIZING. Goal: repeat-unlock cycle. They have unlocked before, so you know what they like. Upsell gently. Tease the next thing before pitching.",
    forbiddens: [
      "do not spam offers",
      "do not ignore their cooldown — if they just unlocked, do not immediately pitch again",
    ],
  },
  WHALE: {
    directive: "Phase: WHALE. This is a premium fan. Tone is attentive and VIP. You can pitch custom content and higher anchors. Reply faster, reference them specifically, make them feel known.",
    forbiddens: [
      "do not use cold template language",
      "do not make them wait without a reason",
    ],
    contextWindow: 24,
  },
  REACTIVATION: {
    directive: "Phase: REACTIVATION. They have been silent 7+ days. Re-engage with warmth, a nostalgic callback to a past conversation or shared joke if you have one, or a light 'been a minute' opener. Do NOT pitch this turn.",
    forbiddens: [
      "do not pitch, do not mention price, do not send PPV",
      "do not act hurt or guilt-trip them",
    ],
  },
  COLD: {
    // Canned path — reply pipeline short-circuits to a low-effort template.
    directive: "",
    forbiddens: [],
    canned: true,
    contextWindow: 4,
  },
};

/**
 * A small bank of cold-path replies. Randomly selected by seeded RNG so the
 * same fan doesn't see "lol" three times in a row. Kept deliberately thin;
 * COLD is about spending as little compute as possible per turn.
 */
export const COLD_REPLIES: string[] = [
  "lol",
  "hmm",
  "yeah",
  "ok",
  "mhm",
  "idk",
  "maybe",
  "later 🖤",
];
