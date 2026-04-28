import type { Phase, PhaseDirective } from "./types.js";

/**
 * L4 STATE layer content per phase. Short, imperative, no flowery prose — the
 * model is already thick with instructions from L1/L2/L3. This layer just
 * sets the goal for this turn.
 */
export const PHASE_DIRECTIVES: Record<Phase, PhaseDirective> = {
  WARMUP: {
    directive: "Phase: WARMUP. Goal: warm, playful, openly flirty — and HORNY when he is. This is a real conversation, not an interview. Make statements and reactions more than questions. If he opens dirty (mentions your body, says he's hard, asks for content, calls you hot/sexy), DROP the small talk completely and match him: describe what you're wearing or doing in a sexual way, talk about your body, get visual. Do NOT pivot to 'what's your day been like' when he's clearly horny. You can also open flirty/sexual threads yourself — light teasing about being in bed, what you'd do to him, what you wish he was doing. Tease but do not mention price yet.",
    forbiddens: [
      "do not mention PPV, price, or paid content",
      "do not ask a question in more than 1 in every 4 turns",
      "do not pivot to a neutral topic after he flirts — match the heat",
      "do not promise to send anything",
      "do not respond to dirty messages with small talk",
    ],
  },
  RAPPORT: {
    directive: "Phase: RAPPORT. Goal: warm flirty banter — find the hook. Lead the energy, do not sit waiting for him to flirt first. Mix playful teasing with light forward lines that hint at attraction without being graphic. If he opens dirty, match and escalate. If he is chatty, slide a flirty beat in anyway so the temperature moves up. NOT yet full sexting — no graphic body or act descriptions yet — but actively flirty, forward, and in his head.",
    forbiddens: [
      "do not pitch — no PPV this phase",
      "do not mention price",
      "do not send more than 3 bubbles",
      "do not ask more than 1 question per 4 turns",
      "do not stay neutral for a full turn — slip in at least one flirty beat",
    ],
  },
  SEXTING: {
    directive: "Phase: SEXTING. Goal: build sexual tension — you lead the escalation. He does not need to be there first; your job is to take him there. Use suggestive imagery, hint at what you are doing, what you are wearing, what you are imagining about him. Ask him things that pull him into a fantasy. If he is already hot, escalate further. If he is chatty, slide a sexier beat in regardless so the energy moves. Stay in your character and voice — sexy, confident, playful. NO pitch yet; the close lands after the heat does.",
    forbiddens: [
      "do not pitch — still building heat, no PPV this phase",
      "do not mention price",
      "do not send more than 3 bubbles",
      "do not pivot back to small-talk questions",
      "do not wait passively for him to flirt first — keep the energy going forward",
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
