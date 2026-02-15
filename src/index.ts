import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { resolveConfig } from "./config.js";
import { VaultDB } from "./db.js";
import { sanitize, isValidMemoryText } from "./sanitize.js";
import { evaluateCapture } from "./capture.js";
import { runConsolidation } from "./consolidation.js";

const CATEGORIES = ["preference", "fact", "decision", "entity", "procedure", "context", "other"] as const;
const DEDUP_THRESHOLD = 0.95;
const CAPTURE_THRESHOLD = 0.3;
const MAX_CAPTURES_PER_TURN = 5;

let embedFn: ((text: string) => Promise<number[]>) | null = null;
let db: VaultDB | null = null;
let consolidationTimer: ReturnType<typeof setInterval> | null = null;

async function getEmbedding(text: string): Promise<number[]> {
  if (!embedFn) throw new Error("memory-vault: embedding provider not initialized");
  return embedFn(text);
}

const plugin = {
  id: "memory-vault",
  name: "Memory Vault",
  description: "SQLite-backed long-term memory with BYOK embeddings, smart capture, recency-weighted recall, and consolidation",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    const dbPath = api.resolvePath("~/.openclaw/memory/vault.db");

    // ── Embedding setup ───────────────────────────────────────────────
    // Use OpenClaw's built-in createEmbeddingProvider if available on runtime,
    // otherwise fall back to a simple fetch-based OpenAI-compatible client.
    const runtime = api.runtime as any;

    if (runtime?.createEmbeddingProvider) {
      const provider = runtime.createEmbeddingProvider({
        provider: cfg.embedding.provider === "auto" ? undefined : cfg.embedding.provider,
        apiKey: cfg.embedding.apiKey,
        model: cfg.embedding.model,
      });
      embedFn = async (text: string) => {
        const result = await provider.embed(text);
        return result;
      };
    } else {
      // Fallback: direct OpenAI-compatible fetch
      const apiKey = cfg.embedding.apiKey
        || process.env.OPENAI_API_KEY
        || process.env.GEMINI_API_KEY
        || process.env.VOYAGE_API_KEY;

      if (!apiKey) {
        api.logger.warn("memory-vault: no embedding API key found. Tools will fail until configured.");
      }

      const model = cfg.embedding.model || "text-embedding-3-small";
      const baseUrl = cfg.embedding.provider === "voyage"
        ? "https://api.voyageai.com/v1"
        : cfg.embedding.provider === "gemini"
          ? "https://generativelanguage.googleapis.com/v1beta"
          : "https://api.openai.com/v1";

      embedFn = async (text: string) => {
        const res = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, input: text }),
        });
        if (!res.ok) throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
        const json = (await res.json()) as any;
        return json.data[0].embedding as number[];
      };
    }

    db = new VaultDB(dbPath);
    api.logger.info(`memory-vault: initialized (db: ${dbPath})`);

    // ── Tools ─────────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "memory_save",
        label: "Save Memory",
        description: "Save information to long-term memory. Use this to remember preferences, facts, decisions, or anything the user wants to recall later.",
        parameters: Type.Object({
          text: Type.String({ description: "The information to remember" }),
          category: Type.Optional(Type.Union(CATEGORIES.map((c) => Type.Literal(c)), { description: "Category: preference, fact, decision, entity, procedure, context, other" })),
          importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default 0.7)", minimum: 0, maximum: 1 })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { text, category, importance } = params as { text: string; category?: string; importance?: number };
          const { clean, flagged } = sanitize(text);
          if (flagged) {
            return { content: [{ type: "text" as const, text: "Memory rejected: content flagged by safety filter." }] };
          }
          if (!isValidMemoryText(clean, cfg.captureMaxChars)) {
            return { content: [{ type: "text" as const, text: "Memory rejected: text too short, too long, or mostly code." }] };
          }

          const embedding = await getEmbedding(clean);
          db!.ensureVec(embedding.length);

          // Dedup check
          const similar = db!.findSimilar(embedding, DEDUP_THRESHOLD);
          if (similar.length > 0) {
            return {
              content: [{ type: "text" as const, text: `Memory already exists (${(similar[0].similarity * 100).toFixed(0)}% match): "${similar[0].text.slice(0, 100)}..."` }],
            };
          }

          const id = crypto.randomUUID();
          db!.insert(id, clean, embedding, {
            category: category ?? "other",
            importance: importance ?? 0.7,
          });

          return {
            content: [{ type: "text" as const, text: `Saved to memory [${category ?? "other"}]: "${clean.slice(0, 120)}${clean.length > 120 ? "..." : ""}"` }],
            details: { id, category: category ?? "other" },
          };
        },
      },
      { name: "memory_save" }
    );

    api.registerTool(
      {
        name: "memory_recall",
        label: "Recall Memory",
        description: "Search long-term memories by semantic similarity. Returns the most relevant memories ranked by relevance, recency, and importance.",
        parameters: Type.Object({
          query: Type.String({ description: "What to search for" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default 5)", minimum: 1, maximum: 20 })),
          category: Type.Optional(Type.Union(CATEGORIES.map((c) => Type.Literal(c)), { description: "Filter by category" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { query, limit, category } = params as { query: string; limit?: number; category?: string };
          const embedding = await getEmbedding(query);
          db!.ensureVec(embedding.length);

          const results = db!.knnSearch(embedding, limit ?? cfg.recallLimit, category);
          if (results.length === 0) {
            return { content: [{ type: "text" as const, text: "No memories found." }] };
          }

          const text = results
            .map((r, i) => `${i + 1}. [${r.category}] ${r.text} (score: ${(r.score * 100).toFixed(0)}%)`)
            .join("\n");

          return {
            content: [{ type: "text" as const, text: `Found ${results.length} memories:\n\n${text}` }],
            details: { count: results.length, memories: results.map((r) => ({ id: r.id, text: r.text, category: r.category, score: r.score })) },
          };
        },
      },
      { name: "memory_recall" }
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Forget Memory",
        description: "Delete a memory by ID or by searching for it.",
        parameters: Type.Object({
          memoryId: Type.Optional(Type.String({ description: "Exact memory ID to delete" })),
          query: Type.Optional(Type.String({ description: "Search query to find and delete the closest match" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { memoryId, query } = params as { memoryId?: string; query?: string };

          if (memoryId) {
            const deleted = db!.deleteById(memoryId);
            return {
              content: [{ type: "text" as const, text: deleted ? `Deleted memory ${memoryId}` : `Memory ${memoryId} not found.` }],
            };
          }

          if (query) {
            const embedding = await getEmbedding(query);
            db!.ensureVec(embedding.length);
            const results = db!.knnSearch(embedding, 1);
            if (results.length === 0) {
              return { content: [{ type: "text" as const, text: "No matching memory found." }] };
            }
            const match = results[0];
            const deleted = db!.deleteById(match.id);
            return {
              content: [{ type: "text" as const, text: deleted ? `Deleted memory: "${match.text.slice(0, 100)}..."` : "Failed to delete." }],
              details: { deletedId: match.id },
            };
          }

          return { content: [{ type: "text" as const, text: "Provide either memoryId or query." }] };
        },
      },
      { name: "memory_forget" }
    );

    // ── Hooks ─────────────────────────────────────────────────────────

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event: any) => {
        if (!event.prompt || event.prompt.length < 10) return;
        try {
          const embedding = await getEmbedding(event.prompt);
          db!.ensureVec(embedding.length);
          const results = db!.knnSearch(embedding, cfg.recallLimit);
          if (results.length === 0) return;

          const memories = results
            .map((r) => `- [${r.category}] ${r.text}`)
            .join("\n");

          return {
            prependContext: `<vault-memories trust="unverified">\n${memories}\n</vault-memories>`,
          };
        } catch (e: any) {
          api.logger.warn(`memory-vault: auto-recall failed: ${e.message}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event: any) => {
        if (!event.success || !event.messages) return;
        let captured = 0;

        try {
          for (const msg of event.messages) {
            if (captured >= MAX_CAPTURES_PER_TURN) break;
            if (msg.role !== "user") continue;

            const text = typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ")
                : null;

            if (!text || !isValidMemoryText(text, cfg.captureMaxChars)) continue;

            const { score, category } = evaluateCapture(text);
            if (score < CAPTURE_THRESHOLD) continue;

            const { clean, flagged } = sanitize(text);
            if (flagged) continue;

            const embedding = await getEmbedding(clean);
            db!.ensureVec(embedding.length);

            // Dedup
            const similar = db!.findSimilar(embedding, DEDUP_THRESHOLD);
            if (similar.length > 0) continue;

            const id = crypto.randomUUID();
            db!.insert(id, clean, embedding, { category, importance: Math.min(0.5 + score * 0.3, 0.9) });
            captured++;
            api.logger.info(`memory-vault: auto-captured [${category}]: "${clean.slice(0, 60)}..."`);
          }
        } catch (e: any) {
          api.logger.warn(`memory-vault: auto-capture error: ${e.message}`);
        }
      });
    }

    // ── CLI ────────────────────────────────────────────────────────────

    api.registerCli(
      ({ program }: any) => {
        const vault = program.command("vault").description("Memory vault commands");

        vault
          .command("list")
          .description("List memories")
          .option("--category <cat>", "Filter by category")
          .option("--limit <n>", "Max results", "20")
          .action(async (opts: any) => {
            const rows = db!.allActive(parseInt(opts.limit), opts.category);
            if (rows.length === 0) { console.log("No memories found."); return; }
            for (const r of rows) {
              const date = new Date(r.created_at).toLocaleDateString();
              console.log(`[${r.id.slice(0, 8)}] [${r.category}] ${r.text.slice(0, 80)}... (${date})`);
            }
          });

        vault
          .command("search <query>")
          .description("Search memories")
          .option("--limit <n>", "Max results", "5")
          .action(async (query: string, opts: any) => {
            const embedding = await getEmbedding(query);
            db!.ensureVec(embedding.length);
            const results = db!.knnSearch(embedding, parseInt(opts.limit));
            if (results.length === 0) { console.log("No matches."); return; }
            for (const r of results) {
              console.log(`[${r.id.slice(0, 8)}] [${r.category}] ${(r.score * 100).toFixed(0)}% — ${r.text.slice(0, 80)}`);
            }
          });

        vault
          .command("stats")
          .description("Show memory stats")
          .action(() => {
            const s = db!.stats();
            console.log(`Total: ${s.total}  Active: ${s.active}  Consolidated: ${s.consolidated}`);
            for (const [cat, count] of Object.entries(s.categories)) {
              console.log(`  ${cat}: ${count}`);
            }
          });

        vault
          .command("consolidate")
          .description("Run memory consolidation now")
          .action(async () => {
            console.log("Running consolidation...");
            const merged = await runConsolidation(db!, getEmbedding);
            console.log(`Done. Merged ${merged} cluster(s).`);
          });

        vault
          .command("export")
          .description("Export all memories as JSON")
          .option("--format <fmt>", "Output format", "json")
          .action(() => {
            const rows = db!.allForExport();
            console.log(JSON.stringify(rows, null, 2));
          });

        vault
          .command("import <file>")
          .description("Import memories from JSON file")
          .action(async (file: string) => {
            const { readFileSync } = await import("node:fs");
            const data = JSON.parse(readFileSync(file, "utf-8")) as any[];
            let count = 0;
            for (const row of data) {
              if (!row.text) continue;
              const embedding = await getEmbedding(row.text);
              db!.ensureVec(embedding.length);
              db!.insert(row.id || crypto.randomUUID(), row.text, embedding, {
                category: row.category,
                importance: row.importance,
              });
              count++;
            }
            console.log(`Imported ${count} memories.`);
          });

        vault
          .command("forget <id>")
          .description("Delete a memory by ID")
          .action((id: string) => {
            const deleted = db!.deleteById(id);
            console.log(deleted ? "Deleted." : "Not found.");
          });
      },
      { commands: ["vault"] }
    );

    // ── Service (consolidation background task) ───────────────────────

    api.registerService({
      id: "memory-vault",
      start: async () => {
        if (cfg.consolidation.enabled) {
          const intervalMs = cfg.consolidation.intervalMinutes * 60 * 1000;
          consolidationTimer = setInterval(async () => {
            try {
              const merged = await runConsolidation(db!, getEmbedding);
              if (merged > 0) api.logger.info(`memory-vault: consolidated ${merged} cluster(s)`);
            } catch (e: any) {
              api.logger.warn(`memory-vault: consolidation error: ${e.message}`);
            }
          }, intervalMs);
          api.logger.info(`memory-vault: consolidation scheduled every ${cfg.consolidation.intervalMinutes}m`);
        }
      },
      stop: async () => {
        if (consolidationTimer) clearInterval(consolidationTimer);
        db?.close();
        api.logger.info("memory-vault: stopped");
      },
    });
  },
};

export default plugin;
