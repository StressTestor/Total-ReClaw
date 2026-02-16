# Total-ReClaw

long-term memory plugin for [OpenClaw](https://github.com/nicepkg/openclaw). your agent forgets everything between sessions — this fixes that.

built this because openclaw ships two memory options and both have problems. memory-core is read-only (no save tool, seriously). memory-lancedb is openai-only, caps at 500 chars, breaks on macOS with native binding issues, and has no concept of "this memory is from 3 months ago, maybe rank it lower." so i built something better.

## install

```bash
git clone https://github.com/StressTestor/Total-ReClaw /tmp/Total-ReClaw && cd /tmp/Total-ReClaw && npm install && openclaw plugins install -l /tmp/Total-ReClaw
```

or step by step:

```bash
git clone https://github.com/StressTestor/Total-ReClaw
cd Total-ReClaw
npm install
openclaw plugins install -l .
```

that's it. no config needed — it auto-detects your embedding provider from whatever's already in your openclaw config. if you have an openai or openrouter key configured as a model provider, it'll just use that. env vars (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `VOYAGE_API_KEY`) work too.

zero new native deps. uses better-sqlite3 and sqlite-vec that openclaw already ships.

## bootstrap from existing conversations

already have chat history? seed your memory db from it:

```bash
openclaw vault bootstrap              # scan all sessions
openclaw vault bootstrap --dry-run    # preview what would be captured
openclaw vault bootstrap --sessions-dir /path/to/sessions  # point at any instance
```

this runs the same capture heuristics on your existing transcripts. good for day-one installs where you don't want to start from zero.

## what the agent gets

three tools:

- **memory_save** — save text with optional category and importance score
- **memory_recall** — semantic search, results ranked by relevance + recency + importance
- **memory_forget** — delete by ID or fuzzy search

two hooks (both on by default):

- **auto-recall** — relevant memories injected before each conversation
- **auto-capture** — important user messages saved automatically (preferences, decisions, personal info)

categories: `preference`, `fact`, `decision`, `entity`, `procedure`, `context`, `other`

## cli

```bash
openclaw vault stats              # memory counts by category
openclaw vault list               # list recent memories
openclaw vault list --category preference
openclaw vault search "query"     # semantic search
openclaw vault bootstrap          # build memories from chat history
openclaw vault consolidate        # merge similar old memories
openclaw vault export             # dump as JSON
openclaw vault import file.json   # restore from export
openclaw vault forget <id>        # delete by id
```

## how scoring works

```
score = similarity * (0.5 + 0.3 * recencyDecay + 0.2 * importance) * accessBoost
```

- **similarity** always dominates — cosine distance from the query embedding
- **recency** — exponential decay, 30-day half-life. yesterday's memories rank higher than last month's
- **importance** — 0-1, set at save time or inferred during auto-capture
- **access boost** — memories that get recalled often get a mild bump (capped at 1.3x)

the idea: you asked about your AWS setup yesterday? that memory should rank above something similar you mentioned 6 months ago, even if the old one is a slightly better semantic match.

## auto-capture heuristics

not keyword matching. multi-signal scoring:

| signal | weight | examples |
|--------|--------|----------|
| explicit memory requests | +0.5 | "remember that", "don't forget", "note that" |
| personal info | +0.3 | "my email is", "I prefer", "I use vim" |
| structured data | +0.3 | emails, phone numbers, dates |
| technical decisions | +0.3 | "we'll use postgres", "switched to bun" |
| preference language | +0.2 | "always", "never", "prefer X over Y" |
| code blocks | -0.3 | don't memorize code dumps |
| heavy markdown | -0.2 | don't memorize formatted docs |

threshold: 0.3. max 5 captures per turn. max 2000 chars each. dedup at 0.95 similarity so you don't get 50 copies of the same preference.

## consolidation

background task runs every 6 hours (configurable). finds memories older than 7 days that are >85% similar to each other, merges them into a single memory, re-embeds the merged text. originals get marked as consolidated, not deleted.

keeps the db from bloating over months of use. run it manually with `openclaw vault consolidate`.

## config (optional)

defaults are sane. you only need config if you want to change something:

```yaml
plugins:
  slots:
    memory: total-reclaw
  entries:
    total-reclaw:
      config:
        embedding:
          provider: auto    # openai | gemini | voyage | local | auto
        autoCapture: true
        autoRecall: true
        recallLimit: 5
        captureMaxChars: 2000
        consolidation:
          enabled: true
          intervalMinutes: 360
```

`auto` checks your openclaw model providers first, then falls back to env vars. if you already have openrouter configured for your agent, embeddings just work.

## vs existing options

| | memory-core | memory-lancedb | **total-reclaw** |
|---|---|---|---|
| save tool | no | yes | **yes** |
| embedding providers | n/a | openai only | **any (auto-detects)** |
| max capture | n/a | 500 chars | **2000 chars** |
| recency weighting | no | no | **yes** |
| consolidation | no | no | **yes** |
| native deps | none | lancedb (macOS issues) | **none new** |
| capture heuristics | n/a | keyword regex | **multi-signal scoring** |
| bootstrap from history | no | no | **yes** |

## project structure

```
src/
  index.ts           — plugin entry, tool/hook/cli/service registration
  config.ts          — config schema + defaults
  db.ts              — VaultDB class (sqlite + sqlite-vec)
  scoring.ts         — recency/importance/access weighted scoring
  capture.ts         — smart auto-capture heuristics
  consolidation.ts   — background memory merger
  sanitize.ts        — prompt injection protection
```

single sqlite db at `~/.openclaw/memory/vault.db`. embeddings stored as float32 vectors via sqlite-vec.

## notes

- embedding dimensions are detected automatically on first use. works with any model.
- prompt injection patterns are filtered before storage (no "ignore previous instructions" in your memory db)
- the `<vault-memories>` block injected during auto-recall is tagged `trust="unverified"` so the agent knows these are stored memories, not system instructions
- dedup threshold is 0.95 — high enough to catch exact rephrases, low enough to let genuinely different memories through

## license

MIT

## day 1 of 20 days of claw
