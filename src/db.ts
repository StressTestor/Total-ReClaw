import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { finalScore } from "./scoring.js";

function requireNodeSqlite(): typeof import("node:sqlite") {
  const require = createRequire(import.meta.url);
  return require("node:sqlite") as typeof import("node:sqlite");
}

function vectorToBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export interface MemoryRow {
  id: string;
  text: string;
  category: string;
  importance: number;
  access_count: number;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
  consolidated_into: string | null;
  agent_id: string | null;
  namespace: string;
  metadata: string | null;
}

export interface SearchResult extends MemoryRow {
  distance: number;
  similarity: number;
  score: number;
}

function toMemoryRow(row: unknown): MemoryRow {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    text: r.text as string,
    category: r.category as string,
    importance: r.importance as number,
    access_count: r.access_count as number,
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
    last_accessed_at: (r.last_accessed_at as number | null) ?? null,
    consolidated_into: (r.consolidated_into as string | null) ?? null,
    agent_id: (r.agent_id as string | null) ?? null,
    namespace: r.namespace as string,
    metadata: (r.metadata as string | null) ?? null,
  };
}

export class VaultDB {
  private db: InstanceType<typeof import("node:sqlite").DatabaseSync>;
  private dimensions: number | null = null;
  private vecReady = false;

  constructor(private dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        importance REAL NOT NULL DEFAULT 0.7,
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER,
        consolidated_into TEXT,
        agent_id TEXT,
        namespace TEXT NOT NULL DEFAULT 'default',
        metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS vault_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
      CREATE INDEX IF NOT EXISTS idx_memories_consolidated ON memories(consolidated_into);
    `);
  }

  ensureVec(dimensions: number) {
    if (this.vecReady) return;
    this.dimensions = dimensions;

    try {
      this.db.exec("SELECT * FROM memory_vec LIMIT 0");
      // Table exists — verify dimensions match
      const stored = this.db.prepare(
        "SELECT value FROM vault_meta WHERE key = 'dimensions'"
      ).get() as Record<string, unknown> | undefined;
      if (stored) {
        const storedDims = parseInt(stored.value as string);
        if (storedDims !== dimensions) {
          throw new Error(
            `total-reclaw: dimension mismatch — db has ${storedDims}, caller passed ${dimensions}. ` +
            `Delete vault.db to re-embed with new model, or switch back to a ${storedDims}-dim model.`
          );
        }
      }
      this.vecReady = true;
      return;
    } catch (e: any) {
      if (e.message?.includes("dimension mismatch")) throw e;
      // Table doesn't exist yet
    }

    try {
      (this.db as any).enableLoadExtension(true);
      const sqliteVec = createRequire(import.meta.url)("sqlite-vec");
      sqliteVec.load(this.db);
    } catch (e: any) {
      throw new Error(`Failed to load sqlite-vec extension: ${e.message}`);
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${dimensions}]
      )
    `);
    this.db.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?, ?)")
      .run("dimensions", String(dimensions));
    this.vecReady = true;
  }

  insert(id: string, text: string, embedding: number[], opts: {
    category?: string;
    importance?: number;
    agentId?: string;
    namespace?: string;
    metadata?: Record<string, unknown>;
    createdAt?: number;
  } = {}): void {
    const now = Date.now();
    this.ensureVec(embedding.length);

    this.db.prepare(`
      INSERT INTO memories (id, text, category, importance, access_count, created_at, updated_at, agent_id, namespace, metadata)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      id, text,
      opts.category ?? "other",
      opts.importance ?? 0.7,
      opts.createdAt ?? now, now,
      opts.agentId ?? null,
      opts.namespace ?? "default",
      opts.metadata ? JSON.stringify(opts.metadata) : null
    );

    this.db.prepare("INSERT INTO memory_vec (id, embedding) VALUES (?, ?)")
      .run(id, vectorToBuffer(embedding));
  }

  knnSearch(queryVec: number[], limit: number, category?: string): SearchResult[] {
    if (!this.vecReady) return [];
    const candidateLimit = limit * 3;

    let rows: any[];
    if (category) {
      rows = this.db.prepare(`
        SELECT m.*, vec_distance_cosine(v.embedding, ?) AS distance
        FROM memory_vec v
        JOIN memories m ON m.id = v.id
        WHERE m.consolidated_into IS NULL AND m.category = ?
        ORDER BY distance ASC
        LIMIT ?
      `).all(vectorToBuffer(queryVec), category, candidateLimit) as any[];
    } else {
      rows = this.db.prepare(`
        SELECT m.*, vec_distance_cosine(v.embedding, ?) AS distance
        FROM memory_vec v
        JOIN memories m ON m.id = v.id
        WHERE m.consolidated_into IS NULL
        ORDER BY distance ASC
        LIMIT ?
      `).all(vectorToBuffer(queryVec), candidateLimit) as any[];
    }

    const now = Date.now();
    const scored: SearchResult[] = rows.map((r: any) => {
      const similarity = 1 - r.distance;
      return {
        ...r,
        similarity,
        score: finalScore(similarity, r.created_at, r.importance, r.access_count, now),
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    // Bump access counts
    const stmt = this.db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?"
    );
    for (const r of top) stmt.run(now, r.id);

    return top;
  }

  findSimilar(embedding: number[], threshold: number): SearchResult[] {
    if (!this.vecReady) return [];
    const rows = this.db.prepare(`
      SELECT m.*, vec_distance_cosine(v.embedding, ?) AS distance
      FROM memory_vec v
      JOIN memories m ON m.id = v.id
      WHERE m.consolidated_into IS NULL
      ORDER BY distance ASC
      LIMIT 5
    `).all(vectorToBuffer(embedding)) as any[];

    return rows
      .map((r: any) => ({ ...r, similarity: 1 - r.distance, score: 0 }))
      .filter((r: any) => r.similarity >= threshold);
  }

  deleteById(id: string): boolean {
    const res = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    try { this.db.prepare("DELETE FROM memory_vec WHERE id = ?").run(id); } catch {}
    return (res as any).changes > 0;
  }

  markConsolidated(ids: string[], newId: string) {
    const stmt = this.db.prepare("UPDATE memories SET consolidated_into = ? WHERE id = ?");
    for (const id of ids) stmt.run(newId, id);
  }

  getActiveOlderThan(ageMs: number): MemoryRow[] {
    const cutoff = Date.now() - ageMs;
    return (this.db.prepare(
      "SELECT * FROM memories WHERE consolidated_into IS NULL AND created_at < ? ORDER BY created_at ASC"
    ).all(cutoff) as unknown[]).map(toMemoryRow);
  }

  getVecById(id: string): number[] | null {
    if (!this.vecReady) return null;
    try {
      const row = this.db.prepare("SELECT embedding FROM memory_vec WHERE id = ?").get(id) as any;
      if (!row) return null;
      return Array.from(new Float32Array(row.embedding.buffer ?? row.embedding));
    } catch {
      return null;
    }
  }

  stats(): { total: number; active: number; consolidated: number; categories: Record<string, number> } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM memories").get() as any).c;
    const active = (this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE consolidated_into IS NULL").get() as any).c;
    const consolidated = total - active;
    const cats = this.db.prepare(
      "SELECT category, COUNT(*) as c FROM memories WHERE consolidated_into IS NULL GROUP BY category"
    ).all() as any[];
    const categories: Record<string, number> = {};
    for (const r of cats) categories[r.category] = r.c;
    return { total, active, consolidated, categories };
  }

  allActive(limit: number, category?: string): MemoryRow[] {
    if (category) {
      return (this.db.prepare(
        "SELECT * FROM memories WHERE consolidated_into IS NULL AND category = ? ORDER BY updated_at DESC LIMIT ?"
      ).all(category, limit) as unknown[]).map(toMemoryRow);
    }
    return (this.db.prepare(
      "SELECT * FROM memories WHERE consolidated_into IS NULL ORDER BY updated_at DESC LIMIT ?"
    ).all(limit) as unknown[]).map(toMemoryRow);
  }

  allForExport(): MemoryRow[] {
    return (this.db.prepare("SELECT * FROM memories ORDER BY created_at ASC").all() as unknown[]).map(toMemoryRow);
  }

  transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close() {
    try { this.db.close(); } catch {}
  }
}
