const INJECTION_PATTERNS = [
  /\bsystem\s*:/i,
  /\bignore\s+(previous|above|all)\s+instructions/i,
  /\byou\s+are\s+now\b/i,
  /\bforget\s+(everything|all|your)\b/i,
  /\bnew\s+instructions?\b/i,
  /<\/?system>/i,
  /\bdo\s+not\s+follow\b/i,
  /\boverride\b/i,
  /\bjailbreak\b/i,
];

export function sanitize(text: string): { clean: string; flagged: boolean } {
  const flagged = INJECTION_PATTERNS.some((p) => p.test(text));
  // Strip XML-like tags that could confuse context injection
  const clean = text
    .replace(/<\/?(?:system|instructions?|prompt|context|role)[^>]*>/gi, "")
    .trim();
  return { clean, flagged };
}

export function isValidMemoryText(text: string, maxChars: number): boolean {
  if (!text || text.length < 5 || text.length > maxChars) return false;
  // Reject if mostly code (>60% code block content)
  const codeBlockChars = (text.match(/```[\s\S]*?```/g) || []).join("").length;
  if (codeBlockChars / text.length > 0.6) return false;
  return true;
}
