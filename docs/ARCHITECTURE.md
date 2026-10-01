# KolobokMemory — Architecture

> **Status disclaimer.** KolobokMemory is a **standalone memory engine** today.
> Its current storage adapter is **OpenViking**, and its current runtime host is
> **OpenClaw** (as a plugin exposing recall + write pipelines). It is **NOT** the
> built-in memory of any external platform, and it is **NOT** wired into any
> "Kolobok" core. A direct adapter for another host would be a separate port and
> a later version — not a rewrite of this project's history.

## High-level flow

### Write path

```
Conversation turn
    ↓
[1] Secret / Safety Filter      deterministic; secrets redacted, never stored
    ↓
[2] Candidate Extraction        structured {entity, property, value, confidence}
    ↓
[3] Write Gate                  KEEP / SKIP per candidate (reason-coded)
    ↓
[4] Dedup / Lookup              SAME / NOVEL / AMBIGUOUS / NOT_FOUND vs store
    ↓
[5] Trust / Conflict            confidence + conflict resolution (no auto-resolve)
    ↓
[6] Decision                    WRITE_NEW / UPDATE / SUPERSEDE / SKIP
    ↓
[7] Writer                      idempotent, journal-resumable, read-back verified
    ↓
Memory storage (OpenViking)
```

### Read path

```
Query
    ↓
Retrieval                    hybrid search (OpenViking /search/find)
    ↓
Relevance Gate               bounded top-N by score threshold
    ↓
Bounded Context Injection    L0 / L1 / L2, per-level char & item caps
```

## Components

| Module | Responsibility |
| --- | --- |
| `index.js` | read-path pipeline, retrieval, Jev gating, context injection, hook registration |
| `write/index.js` | write orchestration (shadow → dedup → decision) |
| `write/secret-filter.js` | deterministic secret detection + redaction |
| `write/extract.js` | candidate extraction from sanitised text |
| `write/normalize.js` | value normalisation + equivalence |
| `write/gate.js` | write gate (KEEP/SKIP, `SKIP_REASONS`) |
| `write/lookup.js` | query construction for dedup lookup |
| `write/dedup.js` | dedup classification (`DEDUP_STATUS`, `FUTURE_ACTION`) |
| `write/trust.js` | confidence classification |
| `write/conflict.js` | decision engine (`DECISION`, `resolveDecision`) |
| `write/writer.js` | isolated writer (idempotent, journal-resumable) |
| `write/layout.js` | namespace allowlist + URI safety + content serialisation |
| `write/http.js` | minimal OpenViking HTTP client |
| `write/shadow-hook.js` | trace-only shadow validation hook |
| `write/production.js` | production capability + policy gate + backup/rollback |
| `write/trace.js` | serialisable trace entries (secret *types* only) |

## Storage boundary

Storage is reached exclusively through `write/http.js` (`createClient`) and the
read path in `index.js`. The storage backend is OpenViking over HTTP:

- write: `POST /api/v1/content/write` (mode `create` | `replace` | `append`)
- read:  `GET  /api/v1/content/read?raw=true`
- fs:    `mkdir`, `mv`, `ls`, `stat`, `DELETE /api/v1/fs`
- search:`POST /api/v1/search/find` (returns `{ memories, resources }`)

The read path consumes **only** `result.memories`; items returned under
`resources` are ignored for injection. This is deliberate: test/resource
namespace objects must never become production memory.

## Namespace separation (capability split)

- **Test capability** — `viking://resources/stage5-test/` (`WRITE_ALLOWLIST` in
  `write/layout.js`). Used by the isolated writer for staging/proofs.
- **Production capability** — `viking://user/default/memories/`
  (`PRODUCTION_ALLOWLIST` in `write/production.js`). Reachable **only** through
  the dedicated `canaryWrite` production policy gate.

The test writer API can never touch production; production is a separate,
separately-audited entry point.

## OpenClaw integration boundary

The plugin is registered via `openclaw.plugin.json` (`activation.onStartup`,
`onCapabilities: ["hook"]`). Integration points:

- **Recall** — a recall context provider that runs the read pipeline and returns
  bounded injected context (L0/L1/L2).
- **Write (shadow)** — an `agent_end` observation hook runs the write-decision
  pipeline over the completed turn **without** physical mutation (trace only).

The write pipeline is a separate capability from the read pipeline. Production
memory mutation is gated behind the production policy gate and is **not** enabled
by default.