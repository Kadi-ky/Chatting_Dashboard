/**
 * Belt-and-suspenders for the L3 humanness forbidden phrasebook. Even though
 * the prompt says "never use these", the model occasionally slips. This pass
 * strips or rewrites the worst offenders post-hoc so the fan never sees them.
 */
const REWRITES: Array<[RegExp, string]> = [
  [/\bcertainly\b/gi, ""],
  [/\babsolutely\b/gi, ""],
  [/\bas an ai\b[^.?!]*[.?!]?/gi, ""],
  [/\bi understand\b/gi, "i get it"],
  [/\bi apologi[sz]e\b/gi, "sorry"],
  [/\bthat is a great question\b/gi, ""],
  [/\bgreat question\b/gi, ""],
  [/\bhappy to\b/gi, "down to"],
  [/\blet me (?=\w)/gi, ""],
  [/\bi'?d be (?:glad|happy) to\b/gi, "down to"],
  [/\breach out\b/gi, "hit me up"],
  [/\bcircle back\b/gi, "come back"],
  [/\btouch base\b/gi, "check in"],
];

export function scrubForbidden(text: string): string {
  let result = text;
  for (const [re, replacement] of REWRITES) {
    result = result.replace(re, replacement);
  }
  // collapse any double-spaces / stranded punctuation the rewrites created
  return result.replace(/\s{2,}/g, " ").replace(/\s+([.?!,])/g, "$1").trim();
}
