# KolobokMemory — Testing

## Suites

Located in `test/`:

- `index.test.js` — read-path: retrieval, Jev gating, context injection, synthetic-detection.
- `write.test.js` — write gate + secret filter + extraction (base write pipeline).
- `write-dedup.test.js` — dedup classification (SAME/NOVEL/AMBIGUOUS/NOT_FOUND).
- `write-conflict.test.js` — decision engine (WRITE_NEW/UPDATE/SUPERSEDE/SKIP).
- `writer.test.js` — isolated writer: idempotency, journal replay, history, supersede.
- `shadow-hook.test.js` — shadow (trace-only) hook: no physical write on shadow path.
- `smoke-42.mjs` — smoke harness for the read pipeline.

> Note: `node --test test/` uses a glob that may fail to resolve in some
> environments; run test files explicitly (`node --test test/index.test.js` etc.)
> if the glob fails.

## Categories

### Unit tests

Deterministic, no network: gate, secret filter, extract, normalize, dedup,
conflict, layout (URI safety), trace serialisation.

### Adversarial tests

- `isSafeUri` / allowlist: percent-encoded traversal (`%2e%2e`, `%2F`), CR/LF
  injection, sibling-prefix bypass (`stage5-test-evil`).
- Secret filter: varied secret shapes (`sk-…`, `sk-or-v1-…`, `sk-live-…`,
  PEM blocks).
- Namespace escape: writer must not write outside its allowlist.

### Shadow validation

The shadow hook runs the full write-decision pipeline over real turns **without**
physical mutation, emitting a trace. Used to measure decision correctness against
gold-annotated fixtures (candidate precision/recall, write-decision
precision/recall, false positive/negative write rate, secret leak rate, duplicate
write intent rate, silent conflict overwrite rate).

### Canary methodology

Before any production mutation:

1. Production manifest + sha256 snapshot (baseline).
2. Backup of the affected slot/object.
3. Rollback implementation + rollback proof on the **test** namespace.
4. A single gated `WRITE_NEW` canary into production, with read-back + read-path
   verification.
5. Rollback/removal of the canary object; confirm production returns to baseline.

### Regression procedure

- `node --check` on every changed `.js`.
- Full unit + adversarial suite (no network).
- Shadow validation over the evaluation dataset.
- Any live/integration gate guarded by an explicit opt-in (`WRITER_LIVE=1`,
  `write.enabled`, `write.productionEnabled`, `write.canary`).

## Running

```bash
node --test test/index.test.js
node --test test/write.test.js
node --test test/write-dedup.test.js
node --test test/write-conflict.test.js
node --test test/writer.test.js
node --test test/shadow-hook.test.js
```