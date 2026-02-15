const EXPLICIT_MEMORY = /\b(remember|don't forget|note that|keep in mind|save this)\b/i;
const PERSONAL_INFO = /\b(my |I prefer|I use |I like |I need |we decided|I always|I never)\b/i;
const STRUCTURED_DATA = /(\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d{3}[-.]?\d{3}[-.]?\d{4}\b|\b\d{4}[-/]\d{2}[-/]\d{2}\b)/i;
const TECH_DECISION = /\b(we'll use|switched to|let's go with|migrated to|chose|decided on|going with)\b/i;
const PREFERENCE = /\b(always|never|prefer|instead of|rather than|better than)\b/i;
const RELEVANT_MEMORIES_TAG = /<relevant-memories|<vault-memories/;

export interface CaptureResult {
  score: number;
  category: string;
}

const CATEGORIES: Array<[RegExp, string, number]> = [
  [EXPLICIT_MEMORY, "preference", 0.5],
  [PERSONAL_INFO, "preference", 0.3],
  [STRUCTURED_DATA, "entity", 0.3],
  [TECH_DECISION, "decision", 0.3],
  [PREFERENCE, "preference", 0.2],
];

export function evaluateCapture(text: string): CaptureResult {
  if (!text || text.length < 20 || text.length > 2000) return { score: 0, category: "other" };
  if (RELEVANT_MEMORIES_TAG.test(text)) return { score: 0, category: "other" };

  let score = 0;
  let bestCategory = "other";
  let bestCategoryScore = 0;

  for (const [pattern, category, weight] of CATEGORIES) {
    if (pattern.test(text)) {
      score += weight;
      if (weight > bestCategoryScore) {
        bestCategoryScore = weight;
        bestCategory = category;
      }
    }
  }

  // Penalties
  const codeBlocks = (text.match(/```/g) || []).length;
  if (codeBlocks >= 2) score -= 0.3;
  const markdownHeaders = (text.match(/^#{1,6}\s/gm) || []).length;
  if (markdownHeaders >= 3) score -= 0.2;

  return { score: Math.max(0, score), category: bestCategory };
}
