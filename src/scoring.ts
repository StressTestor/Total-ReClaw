const HALF_LIFE_DAYS = 30;
const DECAY_LAMBDA = Math.LN2 / (HALF_LIFE_DAYS * 24 * 60 * 60 * 1000);

export function recencyDecay(createdAt: number, now: number = Date.now()): number {
  const age = now - createdAt;
  return Math.exp(-DECAY_LAMBDA * age);
}

export function accessBoost(accessCount: number): number {
  return Math.min(1.3, 1 + Math.log2(1 + accessCount) * 0.1);
}

export function finalScore(
  similarity: number,
  createdAt: number,
  importance: number,
  accessCount: number,
  now: number = Date.now()
): number {
  const recency = recencyDecay(createdAt, now);
  const boost = accessBoost(accessCount);
  return similarity * (0.5 + 0.3 * recency + 0.2 * importance) * boost;
}
