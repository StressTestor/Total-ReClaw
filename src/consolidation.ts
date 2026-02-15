import type { VaultDB, MemoryRow } from "./db.js";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.85;

interface EmbedFn {
  (text: string): Promise<number[]>;
}

export async function runConsolidation(db: VaultDB, embedFn: EmbedFn): Promise<number> {
  const old = db.getActiveOlderThan(SEVEN_DAYS);
  if (old.length < 2) return 0;

  const clustered = new Set<string>();
  let mergeCount = 0;

  for (const mem of old) {
    if (clustered.has(mem.id)) continue;
    const vec = db.getVecById(mem.id);
    if (!vec) continue;

    const neighbors = db.findSimilar(vec, SIMILARITY_THRESHOLD)
      .filter((n) => n.id !== mem.id && !clustered.has(n.id));

    if (neighbors.length === 0) continue;

    const cluster = [mem, ...neighbors.map((n) => old.find((m) => m.id === n.id)!).filter(Boolean)];
    const mergedText = cluster.map((m) => m.text).join(" | ");
    const maxImportance = Math.max(...cluster.map((m) => m.importance));

    const newId = crypto.randomUUID();
    const newVec = await embedFn(mergedText);

    db.insert(newId, mergedText, newVec, {
      category: mem.category,
      importance: maxImportance,
    });
    db.markConsolidated(cluster.map((m) => m.id), newId);

    for (const m of cluster) clustered.add(m.id);
    mergeCount++;
  }

  return mergeCount;
}
