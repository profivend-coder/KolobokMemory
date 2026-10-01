# KolobokMemory — Security

## Threat model

KolobokMemory writes durable facts derived from user/assistant conversation into
a long-term store. The primary risks are:

1. **Secret leakage** — credentials, tokens, keys in the value path reaching storage.
2. **Silent overwrite** — a wrong/conflicting fact clobbering a correct one.
3. **Cross-namespace write** — test/resource data leaking into production memory.
4. **Non-idempotent replay** — duplicate memories on retry.
5. **Unbounded mutation** — runaway writes flooding production.

## Controls

### 1. Secret filtering (`write/secret-filter.js`)

- Deterministic scan runs **before any extraction or mutation**.
- Detected values are `[REDACTED]`; `scanSecrets` returns the secret *types*
  only — never the values.
- Re-run immediately before the first mutation (`REJECT_SECRET` short-circuits
  to zero mutation).
- Traces carry `secretTypes` only.

### 2. Fail-closed writes

- `write.enabled=false` → the pipeline runs trace-only; no physical write.
- Any gate failure returns `{ mutation: false }` with a reason code.
- `SKIP_*` decisions never reach the writer.

### 3. Namespace protection (`write/layout.js`)

- `WRITE_ALLOWLIST` restricts the isolated writer to the test namespace.
- `isSafeUri` percent-decodes each segment and rejects `..`, `%2F`, CR/LF, and
  sibling-prefix bypasses (e.g. `stage5-test-evil`).
- Production `memories/` is reachable **only** through `write/production.js`'s
  `canaryWrite` — a separate, separately-audited gate.

### 4. Idempotency & resumability (`write/writer.js`)

- Journal-based writes with a deterministic `operation_id` derived from
  `(slot, action)` / `(entity, property, value)`.
- `mode: create` returns `ALREADY_EXISTS` on a duplicate URI → short-circuits to
  `IDEMPOTENT_SUCCESS` (no duplicate).
- Replay of an already-committed operation produces no duplicate memory.

### 5. Conflict handling (`write/conflict.js`, `write/dedup.js`)

- `UPDATE` refines an existing memory; `SUPERSEDE` corrects it (old version kept
  as history, `superseded_by` link).
- A conflict **without** explicit correction is never auto-resolved — it results
  in no overwrite (fail-closed).

### 6. Backup / rollback / recovery (`write/production.js`)

- `backupSlot` captures prior content before mutation.
- `rollback` restores prior content, or deletes the object if the slot was absent
  before the write.
- Recovery is via journal replay (idempotent).

### 7. Production capability separation

- Production policy gate requires `write.enabled` AND `write.productionEnabled`
  AND `write.canary` to be true simultaneously, plus decision/schema/dedup/secret/
  rate checks. Any one false → zero production mutation.
- Canary permits only `WRITE_NEW`; `UPDATE`/`SUPERSEDE` production paths are a
  later rollout stage.

## Invariants

1. Secrets are never stored; traces contain secret *types* only.
2. A doubtful write is skipped — never silently written.
3. Test/resource-namespace objects never become production memory injection.
4. Replay of a committed operation produces no duplicate.
5. No cross-namespace write without the production policy gate.