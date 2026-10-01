# KolobokMemory

Selective long-term memory engine for AI agents.

A fail-closed, bounded memory write/read pipeline over the OpenViking memory
store. KolobokMemory turns raw conversation turns into durable, retrievable
memories — and only writes what is genuinely worth remembering. It never
silently overwrites, never leaks secrets, and never lets test/resource data
become production memory.

## What this is (and is not)

> **Current scope.** KolobokMemory is a **standalone memory engine**. Its
> storage adapter is **OpenViking**, and its runtime host is **OpenClaw** (as a
> plugin exposing recall + write pipelines).
>
> It is **not** the built-in memory of `/root/Kolobok/platform`. It is not wired
> into any Kolobok core, and no direct Kolobok adapter exists yet. A future
> adapter for Kolobok Core would be a separate port and a later version — not a
> rewrite of this project's history.

## Architecture

### Write path

```
Conversation
    ↓
Candidate Extraction      (structured candidates from sanitised text)
    ↓
Secret Filter             (deterministic; secrets are redacted, never stored)
    ↓
Write Gate                (KEEP / SKIP per candidate, reason-coded)
    ↓
Dedup / Existing Memory Lookup   (SAME / NOVEL / AMBIGUOUS / NOT_FOUND)
    ↓
Trust / Conflict Resolution      (confidence + conflict, no silent resolution)
    ↓
WRITE_NEW / UPDATE / SUPERSEDE / SKIP
    ↓
Memory Storage            (idempotent, journal-resumable, read-back verified)
```

### Read path

```
Query
    ↓
Retrieval                 (hybrid search with relevance scoring)
    ↓
Relevance Gate            (bounded top-N by score threshold)
    ↓
Bounded Context Injection (L0 / L1 / L2, per-level char & item caps)
```

## Safety model

- **Fail-closed for write.** Better to miss a memory than write a doubtful one.
- **Secret filter first.** Secrets are scanned and removed before any extraction
  or mutation; traces contain secret *types* only, never values.
- **No silent overwrite.** UPDATE refines, SUPERSEDE corrects, conflicts without
  explicit correction are never auto-resolved.
- **Capability split.** The test namespace (`viking://resources/stage5-test/`) and
  production memory (`viking://user/default/memories/`) are separate capabilities.
  Production is reachable only through a dedicated production policy gate.
- **Idempotent & resumable.** Journal-based writes with a deterministic
  `operation_id`; replay produces no duplicates.

## Layout

```
index.js                     read-path pipeline + hook registration
openclaw.plugin.json         plugin manifest + config schema
package.json                 package metadata
write/
  index.js                   write pipeline orchestrator (shadow mode foundation)
  extract.js                 candidate extraction
  secret-filter.js           deterministic secret/safety filter
  gate.js                    write gate (KEEP/SKIP, reason codes)
  normalize.js               value normalisation
  lookup.js                  query construction for dedup lookup
  dedup.js                   dedup classification (SAME/NOVEL/AMBIGUOUS/NOT_FOUND)
  trust.js                   confidence classification
  conflict.js                decision engine (WRITE_NEW/UPDATE/SUPERSEDE/SKIP)
  writer.js                  isolated writer (idempotent, journal-resumable)
  layout.js                  namespace allowlist + URI safety helpers
  http.js                    minimal OpenViking HTTP client
  shadow-hook.js             shadow (trace-only) validation hook
  production.js              production capability + policy gate + backup/rollback
  trace.js                   serialisable trace entries
test/                        unit + integration + smoke tests
docs/
  ARCHITECTURE.md            read/write path, decisions, storage & integration boundaries
  SECURITY.md                secret filtering, fail-closed, namespaces, rollback
  TESTING.md                 unit, adversarial, shadow, canary, regression
```

## Status

KolobokMemory is currently in **shadow / canary stage**. The full write pipeline
runs end-to-end in trace-only mode; production memory mutation is gated behind
`write.enabled`, `write.productionEnabled` and `write.canary` (all must be true,
and only `WRITE_NEW` is permitted under canary). UPDATE / SUPERSEDE production
paths are next in the rollout sequence.

No release tag is published until the memory-write rollout reaches its final
production PASS.

## Development

```bash
node --check write/*.js index.js   # syntax check
node --test test/                  # run the test suite
```