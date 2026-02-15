# memory-vault

Long-term memory plugin for [OpenClaw](https://github.com/nicepkg/openclaw). SQLite-backed, BYOK embeddings, smart capture, recency-weighted recall, memory consolidation.

## Install

```
openclaw plugins install -l https://github.com/nicepkg/memory-vault
```

Then activate it:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-vault"
    }
  }
}
```

That's it. No config needed — it auto-detects your embedding provider from environment variables (`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `VOYAGE_API_KEY`).

## What the agent gets

Three tools:
- **memory_save** — save a memory with optional category and importance
- **memory_recall** — semantic search with recency-weighted ranking
- **memory_forget** — delete by ID or fuzzy search

Two hooks (both on by default):
- **Auto-recall** — relevant memories injected before each conversation
- **Auto-capture** — important user messages saved automatically

## CLI

```bash
openclaw vault stats          # memory counts by category
openclaw vault list           # list recent memories
openclaw vault search "query" # semantic search
openclaw vault consolidate    # merge similar old memories
openclaw vault export         # dump as JSON
openclaw vault import file.json
openclaw vault forget <id>
```

## Config (optional)

```yaml
plugins:
  slots:
    memory: memory-vault
  entries:
    memory-vault:
      config:
        embedding:
          provider: auto  # openai | gemini | voyage | local
        autoCapture: true
        autoRecall: true
        recallLimit: 5
        captureMaxChars: 2000
        consolidation:
          enabled: true
          intervalMinutes: 360
```

## How scoring works

```
score = similarity * (0.5 + 0.3 * recencyDecay + 0.2 * importance) * accessBoost
```

- **Similarity** always dominates (vector cosine distance)
- **Recency** — exponential decay with 30-day half-life
- **Importance** — 0-1, set at save time
- **Access boost** — frequently recalled memories get a mild boost (max 1.3x)

## vs existing options

| Feature | memory-core | memory-lancedb | **memory-vault** |
|---------|-------------|----------------|-----------------|
| Save tool | No | Yes | **Yes** |
| Embedding providers | N/A | OpenAI only | **Any (BYOK)** |
| Max capture | N/A | 500 chars | **2000 chars** |
| Recency weighting | No | No | **Yes** |
| Consolidation | No | No | **Yes** |
| Native deps | None | LanceDB (macOS issues) | **None new** |
| Auto-capture heuristics | N/A | Keyword regex | **Multi-signal scoring** |

## Day 1 of 20 Days of Claw
