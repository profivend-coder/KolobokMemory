// selective-memory — STAGE 5.4 write/writer.js
//
// ISOLATED OPENVIKING WRITER — the first PHYSICAL write path.
//
// Scope is HARD-BOUNDED to the allowlisted test namespace
// (viking://resources/stage5-test/<run-id>/). Production memory is NEVER
// touched: the production namespace is absent from the allowlist, and every
// mutation is rejected unless its URI passes isAllowedUri().
//
// The writer implements three physical operations with a journal-based,
// idempotent, RESUMABLE transaction model:
//
//   WRITE_NEW   — create a slot's active.md + history/v1.md + transition + journal
//   UPDATE      — append history/vN.md, point active.md at vN, write transition
//   SUPERSEDE   — mark prior active superseded, write a NEW slot version with
//                 supersession links, write transition
//
// Idempotency & recovery:
//   - An operation_id is deterministic for (root, slot, action).
//   - Every CREATE step tolerates ALREADY_EXISTS (treated as already-applied),
//     so re-running a partially-applied op RESUME where it left off instead of
//     double-applying or corrupting state.
//   - The journal is written with mode=replace (which the API turns into a
//     create when the file is absent), so it is always idempotent.
//   - A complete journal → IDEMPOTENT_SUCCESS on replay. An in-progress journal
//     with the SAME operation_id → RESUME. A different slot state → conflict.
//
// Failure safety: a "history written, then transition failed" is recovered by
// re-running the same op. No destructive overwrite is ever performed on history
// files (each version is a distinct, create-only URI).
//
// Secret rejection: the writer re-runs the deterministic secret filter on the
// candidate value immediately before the first mutation. Any secret →
// REJECT_SECRET and ZERO mutation.
//
// Concurrency: a per-slot in-process mutex serialises mutations; a stale
// expected_version yields CONFLICT_RETRY_REQUIRED and ZERO destructive overwrite.

import { scanSecrets } from "./secret-filter.js";
import { createClient, readSlot, OvError } from "./http.js";
import {
  isAllowedUri,
  isSafeUri,
  resolveAllowlist,
  newRunId,
  rootUri,
  activeUri,
  historyUri,
  transitionUri,
  journalUri,
  buildActiveContent,
  buildTransitionContent,
  buildJournal,
  parseJournal,
  parseFields,
  bodyOf,
  slotIdFor,
} from "./layout.js";

// Decision actions the writer accepts (from conflict.js). SKIP_* never reaches
// the writer — the caller resolves decisions and only passes a WOULD_* action.
export const WRITE_ACTION = {
  WRITE_NEW: "WRITE_NEW",
  UPDATE: "UPDATE",
  SUPERSEDE: "SUPERSEDE",
};

// Outcome codes (all serialisable, no secrets).
export const OUTCOME = {
  WRITE_NEW: "WRITE_NEW",
  UPDATE: "UPDATE",
  SUPERSEDE: "SUPERSEDE",
  IDEMPOTENT_SUCCESS: "IDEMPOTENT_SUCCESS",
  CONFLICT_RETRY_REQUIRED: "CONFLICT_RETRY_REQUIRED",
  REJECT_SECRET: "REJECT_SECRET",
  REJECT_DECISION: "REJECT_DECISION",
  REJECT_NAMESPACE: "REJECT_NAMESPACE",
  REJECT_NOOP: "REJECT_NOOP",
  ERROR: "ERROR",
};

function opIdFor(root, slotId, action) {
  return `${slotId}__${action}`;
}

function validateCandidate(cand) {
  if (!cand || typeof cand !== "object") return { ok: false, reason: "bad_candidate" };
  if (typeof cand.value !== "string" || !cand.value.trim()) return { ok: false, reason: "missing_value" };
  return { ok: true };
}

/**
 * Writer instance bound to one run namespace.
 *
 * @param {object} cfg  { baseUrl?, apiKey?, timeoutMs?, fetchFn?,
 *                        allowlist?: string[], runId?: string }
 */
export function createWriter(cfg = {}) {
  const client = createClient(cfg);
  const allowlist = resolveAllowlist(cfg);
  const runId = typeof cfg.runId === "string" && cfg.runId ? cfg.runId : newRunId();
  const root = rootUri(runId);
  const locks = new Map(); // slotId -> Promise queue tail

  function lock(slotId, fn) {
    const prev = locks.get(slotId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // chain regardless of prior outcome
    locks.set(slotId, next.catch(() => {}));
    return next;
  }

  function reject(outcome, reason, extra = {}) {
    return { outcome, reason, mutation: false, ...extra };
  }

  function okOutcome(outcome, reason, extra = {}) {
    return { outcome, reason, mutation: true, ...extra };
  }

  // -------------------------------------------------------------------------
  // Guarded primitives (all assert allowlist + URI safety first)
  // -------------------------------------------------------------------------

  function assertUri(uri) {
    if (!isSafeUri(uri)) throw new OvError(`unsafe URI: ${uri}`, { code: "UNSAFE_URI" });
    if (!isAllowedUri(uri, allowlist)) throw new OvError(`namespace escape blocked: ${uri}`, { code: "NAMESPACE_ESCAPE" });
    return uri;
  }

  // Content writes use wait:false — the file is immediately readable; semantic
  // refresh is queued asynchronously and is not needed for event-store correctness.
  async function guardedWrite(uri, content, mode, opts = {}) {
    assertUri(uri);
    return client.write(uri, content, mode, { ...opts, wait: opts.wait === true });
  }

  // Create that tolerates ALREADY_EXISTS (the step was already applied in a
  // prior partial run). Returns { created: boolean }.
  async function idempotentCreate(uri, content) {
    try {
      await guardedWrite(uri, content, "create");
      return { created: true };
    } catch (e) {
      if (e?.code === "ALREADY_EXISTS") return { created: false };
      throw e;
    }
  }

  async function guardedRead(uri) {
    assertUri(uri);
    return client.readText(uri);
  }
  async function guardedRm(uri, opts = {}) {
    assertUri(uri);
    return client.rm(uri, opts);
  }
  async function guardedLs(uri) {
    assertUri(uri);
    return client.lsResult(uri);
  }

  // -------------------------------------------------------------------------
  // Journal helpers
  // -------------------------------------------------------------------------

  async function readJournal(slotId) {
    const uri = journalUri(root, slotId);
    const r = await readSlot(client, uri);
    if (!r.ok) return { ok: false, reason: r.reason, uri };
    const j = parseJournal(r.content);
    if (!j) return { ok: false, reason: "malformed_journal", uri };
    return { ok: true, journal: j, uri };
  }

  async function writeJournal(slotId, journal) {
    const uri = journalUri(root, slotId);
    const content = buildJournal(journal);
    // mode=replace is idempotent: the API creates the file when absent.
    await guardedWrite(uri, content, "replace");
    return uri;
  }

  async function readActive(slotId) {
    const uri = activeUri(root, slotId);
    const r = await readSlot(client, uri);
    if (!r.ok) return { ok: false, reason: r.reason, uri };
    const fields = parseFields(r.content);
    return { ok: true, content: r.content, fields, body: bodyOf(r.content), uri };
  }

  // -------------------------------------------------------------------------
  // Inspection (idempotency / resume decision)
  // -------------------------------------------------------------------------

  async function inspect(slotId, opId) {
    const j = await readJournal(slotId);
    if (j.ok) {
      const done = j.journal?.operation_id === opId && j.journal?.status === "complete";
      const sameOp = j.journal?.operation_id === opId;
      return {
        state: done ? "already_done" : sameOp ? "in_progress" : "other_op",
        journal: j.journal,
        active: await readActive(slotId),
      };
    }
    const a = await readActive(slotId);
    if (a.ok) {
      return { state: "already_done", journal: null, active: a, reason: j.reason };
    }
    return { state: "absent", journal: null, active: null, reason: j.reason };
  }

  // -------------------------------------------------------------------------
  // Core operations (all steps idempotent → resumable)
  // -------------------------------------------------------------------------

  async function writeNew(cand, opId, timestamp) {
    const slotId = slotIdFor(cand.entity, cand.property);
    const version = 1;
    const aUri = activeUri(root, slotId);
    const hUri = historyUri(root, slotId, version);
    const tUri = transitionUri(root, opId, timestamp);
    const content = buildActiveContent({
      entity: cand.entity, property: cand.property, value: cand.value,
      source_type: cand.source_type, confidence: cand.confidence, timestamp,
      version, operation_id: opId,
    });

    const base = {
      operation_id: opId, action: WRITE_ACTION.WRITE_NEW, slot: slotId,
      from_version: null, new_version: version, entity: cand.entity,
      property: cand.property, value: cand.value, source_type: cand.source_type,
      confidence: cand.confidence, timestamp, old_uri: null, reason: "write_new",
    };

    // 1. journal IN_PROGRESS (source of truth before first mutation)
    await writeJournal(slotId, { ...base, status: "in_progress" });

    // 2. immutable history record (create-only, idempotent)
    await idempotentCreate(hUri, content);

    // 3. active.md (create-only, idempotent)
    await idempotentCreate(aUri, content);

    // 4. transition record (create-only, idempotent)
    await idempotentCreate(tUri, buildTransitionContent({
      action: WRITE_ACTION.WRITE_NEW, operation_id: opId, timestamp,
      entity: cand.entity, property: cand.property, source_type: cand.source_type,
      reason: "write_new", to_version: version, new_uri: aUri, new_value: cand.value,
    }));

    // 5. journal COMPLETE
    await writeJournal(slotId, { ...base, status: "complete" });

    return okOutcome(OUTCOME.WRITE_NEW, "created_v1", {
      slotId, version, activeUri: aUri, historyUri: hUri, transitionUri: tUri,
    });
  }

  async function update(cand, opId, timestamp, existing) {
    const slotId = slotIdFor(cand.entity, cand.property);
    const curVersion = typeof existing?.fields?.version === "number" ? existing.fields.version : 0;
    const newVersion = curVersion + 1;
    const aUri = activeUri(root, slotId);
    const hUri = historyUri(root, slotId, newVersion);
    const tUri = transitionUri(root, opId, timestamp);
    const content = buildActiveContent({
      entity: cand.entity, property: cand.property, value: cand.value,
      source_type: cand.source_type, confidence: cand.confidence, timestamp,
      version: newVersion, operation_id: opId, previous_version_uri: existing.uri,
    });

    const base = {
      operation_id: opId, action: WRITE_ACTION.UPDATE, slot: slotId,
      from_version: curVersion, new_version: newVersion, entity: cand.entity,
      property: cand.property, value: cand.value, source_type: cand.source_type,
      confidence: cand.confidence, timestamp, old_uri: existing.uri, reason: "update",
    };

    await writeJournal(slotId, { ...base, status: "in_progress" });

    // 1. immutable history record (create-only, idempotent)
    await idempotentCreate(hUri, content);

    // 2. transition record (create-only, idempotent)
    await idempotentCreate(tUri, buildTransitionContent({
      action: WRITE_ACTION.UPDATE, operation_id: opId, timestamp,
      entity: cand.entity, property: cand.property, source_type: cand.source_type,
      reason: "update", from_version: curVersion, to_version: newVersion,
      old_uri: existing.uri, new_uri: aUri,
      old_value: existing.body, new_value: cand.value,
    }));

    // 3. point active at new version (replace — idempotent)
    await guardedWrite(aUri, content, "replace");

    await writeJournal(slotId, { ...base, status: "complete" });

    return okOutcome(OUTCOME.UPDATE, "updated", {
      slotId, fromVersion: curVersion, version: newVersion, activeUri: aUri,
      historyUri: hUri, transitionUri: tUri,
    });
  }

  async function supersede(cand, opId, timestamp, existing) {
    const slotId = slotIdFor(cand.entity, cand.property);
    const curVersion = typeof existing?.fields?.version === "number" ? existing.fields.version : 0;
    const newVersion = curVersion + 1;
    const aUri = activeUri(root, slotId);
    const hUri = historyUri(root, slotId, newVersion);
    const tUri = transitionUri(root, opId, timestamp);
    const markerUri = `${activeUri(root, slotId)}.superseded-v${curVersion}.md`;
    const superseded = Array.isArray(existing?.fields?.superseded_versions)
      ? existing.fields.superseded_versions
      : [];
    const newSuperseded = [...superseded, curVersion];

    const content = buildActiveContent({
      entity: cand.entity, property: cand.property, value: cand.value,
      source_type: cand.source_type, confidence: cand.confidence, timestamp,
      version: newVersion, operation_id: opId, previous_version_uri: existing.uri,
      superseded_versions: newSuperseded,
    });

    const base = {
      operation_id: opId, action: WRITE_ACTION.SUPERSEDE, slot: slotId,
      from_version: curVersion, new_version: newVersion, entity: cand.entity,
      property: cand.property, value: cand.value, source_type: cand.source_type,
      confidence: cand.confidence, timestamp, old_uri: existing.uri,
      reason: "supersede_explicit_correction",
    };

    await writeJournal(slotId, { ...base, status: "in_progress" });

    // 1. write new history record (create-only, idempotent)
    await idempotentCreate(hUri, content);

    // 2. transition record (create-only, idempotent)
    await idempotentCreate(tUri, buildTransitionContent({
      action: WRITE_ACTION.SUPERSEDE, operation_id: opId, timestamp,
      entity: cand.entity, property: cand.property, source_type: cand.source_type,
      reason: "supersede_explicit_correction", from_version: curVersion, to_version: newVersion,
      old_uri: existing.uri, new_uri: aUri,
      old_value: existing.body, new_value: cand.value,
    }));

    // 3. supersession marker (create-only, idempotent, .md extension)
    await idempotentCreate(markerUri, JSON.stringify({
      superseded_by: aUri, superseded_version: curVersion, superseded_at: timestamp,
    }, null, 2));

    // 4. point active at new version (replace — idempotent)
    await guardedWrite(aUri, content, "replace");

    await writeJournal(slotId, { ...base, status: "complete" });

    return okOutcome(OUTCOME.SUPERSEDE, "superseded", {
      slotId, fromVersion: curVersion, version: newVersion, activeUri: aUri,
      historyUri: hUri, transitionUri: tUri,
    });
  }

  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------

  async function execute(action, candidate, opts = {}) {
    // [0] Secret rejection — deterministic, immediately before first mutation.
    const scan = scanSecrets(typeof candidate?.value === "string" ? candidate.value : "");
    if (scan.found) {
      return reject(OUTCOME.REJECT_SECRET, "secret_in_value", { secretTypes: scan.secrets.map((s) => s.type) });
    }

    const v = validateCandidate(candidate);
    if (!v.ok) return reject(OUTCOME.REJECT_DECISION, v.reason);

    if (![WRITE_ACTION.WRITE_NEW, WRITE_ACTION.UPDATE, WRITE_ACTION.SUPERSEDE].includes(action)) {
      return reject(OUTCOME.REJECT_DECISION, "unsupported_action", { action });
    }

    const timestamp = typeof opts.timestamp === "string" && opts.timestamp ? opts.timestamp : new Date().toISOString();
    const slotId = slotIdFor(candidate.entity, candidate.property);
    const opId = typeof opts.operationId === "string" && opts.operationId
      ? opts.operationId
      : opIdFor(root, slotId, action);

    return lock(slotId, async () => {
      try {
        const insp = await inspect(slotId, opId);

        // Replay of a committed op → idempotent success (no new mutation).
        if (insp.state === "already_done") {
          if (insp.journal?.operation_id === opId && insp.journal?.status === "complete") {
            return okOutcome(OUTCOME.IDEMPOTENT_SUCCESS, "already_committed", { slotId, idempotent: true });
          }
          if (insp.active?.ok && !insp.journal) {
            // Active exists but no journal (previous run committed without one).
            return okOutcome(OUTCOME.IDEMPOTENT_SUCCESS, "recovered_without_journal", { slotId, idempotent: true });
          }
        }

        if (action === WRITE_ACTION.WRITE_NEW) {
          // Fresh slot, or resume of an in-progress op with the SAME operation_id.
          if (insp.state === "absent" || (insp.state === "in_progress" && insp.journal?.operation_id === opId)) {
            return await writeNew(candidate, opId, timestamp);
          }
          return reject(OUTCOME.CONFLICT_RETRY_REQUIRED, "slot_already_exists", { slotId });
        }

        // UPDATE / SUPERSEDE require an existing active.
        if (insp.state === "absent" || !insp.active?.ok) {
          return reject(OUTCOME.CONFLICT_RETRY_REQUIRED, "no_active_to_update", { slotId });
        }
        const existing = insp.active;
        const curVersion = typeof existing?.fields?.version === "number" ? existing.fields.version : 0;
        if (typeof opts.expectedVersion === "number" && opts.expectedVersion !== curVersion) {
          return reject(OUTCOME.CONFLICT_RETRY_REQUIRED, "stale_expected_version", {
            slotId, expected: opts.expectedVersion, actual: curVersion,
          });
        }

        // Allow resume of an in-progress UPDATE/SUPERSEDE with the same op.
        if (insp.state === "in_progress" && insp.journal?.operation_id === opId) {
          return action === WRITE_ACTION.UPDATE
            ? await update(candidate, opId, timestamp, existing)
            : await supersede(candidate, opId, timestamp, existing);
        }

        return action === WRITE_ACTION.UPDATE
          ? await update(candidate, opId, timestamp, existing)
          : await supersede(candidate, opId, timestamp, existing);
      } catch (e) {
        return reject(OUTCOME.ERROR, e?.code ?? e?.message ?? String(e), { slotId, error: e?.message ?? String(e) });
      }
    });
  }

  return {
    runId,
    root,
    allowlist,
    execute,
    // Guarded, allowlist-bound surface ONLY. The raw HTTP client is never
    // exposed: every read/delete below asserts the URI sits inside the
    // allowlisted test namespace before touching the server.
    readActive,
    readJournal,
    readText: guardedRead,
    ls: guardedLs,
    rm: guardedRm,
    isAllowed: (uri) => isAllowedUri(uri, allowlist),
    slotIdFor,
  };
}
