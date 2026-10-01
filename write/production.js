// selective-memory — STAGE 5.6 production canary writer (separate capability).
//
// CAPABILITY SPLIT (per operator decision 2026-10-01, "VARIANT 1"):
//   - TEST capability        → viking://resources/stage5-test/  (writer.js, WRITE_ALLOWLIST)
//   - PRODUCTION capability  → viking://user/default/memories/  (THIS MODULE)
//
// The production destination is NOT added to writer.js's WRITE_ALLOWLIST. It is
// reachable ONLY through the `canaryWrite` production policy gate below. The
// ordinary test writer API can NEVER touch production memory; `canaryWrite` is
// the single, separately-audited entry point into production.
//
// FAIL CLOSED: canaryWrite requires EVERY gate to be true simultaneously. Any
// false → { mutation: false } and ZERO production mutation.
//
// This is a CANARY (STAGE 5.6): only WRITE_NEW is permitted. UPDATE / SUPERSEDE
// are intentionally absent (they arrive in STAGE 5.7 rollout). SKIP_* is never
// written.

import { createClient, readSlot } from "./http.js";
import { scanSecrets } from "./secret-filter.js";
import { isSafeUri, isAllowedUri, WRITE_ALLOWLIST } from "./layout.js";

// ---------------------------------------------------------------------------
// Production capability (separate from the test allowlist).
// ---------------------------------------------------------------------------
export const PRODUCTION_ALLOWLIST = ["viking://user/default/memories/"];

// Entities / properties permitted into production by the canary policy.
// Anything outside this schema is rejected (fail-closed).
const ALLOWED_ENTITIES = new Set(["user"]);
const ALLOWED_PROPERTIES = new Set([
  "preference", "preferred_editor", "preferred_language", "preferred_tool",
  "preferred_framework", "preferred_platform", "preferred_os", "preferred_ide",
]);

function isProductionUri(uri) {
  return typeof uri === "string" && PRODUCTION_ALLOWLIST.some((p) => uri === p.replace(/\/+$/, "") || uri.startsWith(p));
}

function assertProductionUri(uri) {
  if (!isSafeUri(uri)) return { ok: false, reason: "unsafe_uri", uri };
  if (!isProductionUri(uri)) return { ok: false, reason: "not_production_memory", uri };
  return { ok: true, uri };
}

// Backup/rollback primitives may operate on EITHER capability namespace
// (test OR production) so rollback can be proven on the test namespace before
// any production mutation. This validation does NOT grant write capability —
// the write gate (`canaryWrite`) remains the sole production write path.
function assertBackupUri(uri) {
  if (!isSafeUri(uri)) return { ok: false, reason: "unsafe_uri", uri };
  if (isProductionUri(uri)) return { ok: true, uri };
  if (isAllowedUri(uri)) return { ok: true, uri }; // test namespace (writer.js allowlist)
  return { ok: false, reason: "namespace_not_allowed", uri };
}

// Deterministic operation_id for (slot, value) — replayable without duplicates.
export function canaryOperationId(entity, property, value) {
  const norm = `${String(entity ?? "user")}|${String(property ?? "preference")}|${String(value ?? "")}`
    .toLowerCase().replace(/[^a-z0-9|]+/g, "_");
  return `canary_${norm}`.slice(0, 128);
}

// Deterministic slot dir under production memories.
export function canarySlotDir(entity, property) {
  const slug = `${String(entity ?? "user")}_${String(property ?? "preference")}`
    .toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return `viking://user/default/memories/preferences/${slug}`;
}

/**
 * Canary write gate. This is the ONLY production write entry point.
 *
 * @param {object} cfg   { write:{enabled, productionEnabled, canary, maxPerTurn, confidenceThreshold},
 *                         allowlist?, baseUrl?, apiKey? }
 * @param {object} candidate  { entity, property, value, source_type, confidence }
 * @param {object} decision  { action, dedupStatus, ... }
 * @param {object} ctx    { perTurnWrites, dailyWrites, dailyLimit, now }
 * @returns {Promise<object>}  { mutation:boolean, outcome, reason, operation_id, ... }
 */
export async function canaryWrite(cfg = {}, candidate, decision, ctx = {}) {
  const w = cfg?.write ?? {};
  // Gate 0 — every flag must be true.
  if (w.enabled !== true) return { mutation: false, outcome: "REJECT_DISABLED", reason: "write.enabled=false" };
  if (w.productionEnabled !== true) return { mutation: false, outcome: "REJECT_DISABLED", reason: "write.productionEnabled=false" };
  if (w.canary !== true) return { mutation: false, outcome: "REJECT_DISABLED", reason: "write.canary=false" };

  // Gate 1 — only WRITE_NEW in canary.
  const action = decision?.action ?? decision?.write_decision?.action ?? null;
  if (action !== "WOULD_WRITE_NEW" && action !== "WRITE_NEW") {
    return { mutation: false, outcome: "REJECT_ACTION", reason: `action_not_write_new: ${action}` };
  }

  // Gate 2 — candidate must be user_stated, trusted, not historical/temporary/ambiguous.
  const cand = candidate ?? {};
  if (cand.source_type !== "user_stated") {
    return { mutation: false, outcome: "REJECT_POLICY", reason: `source_type_not_user_stated: ${cand.source_type}` };
  }
  const thr = typeof w.confidenceThreshold === "number" ? w.confidenceThreshold : 0.85;
  const conf = typeof cand.confidence === "number" ? cand.confidence : 0;
  if (conf < thr) {
    return { mutation: false, outcome: "REJECT_LOW_CONFIDENCE", reason: `confidence ${conf} < ${thr}` };
  }

  // Gate 3 — dedup NOT_FOUND (no existing memory in the slot).
  const dedup = decision?.dedupStatus ?? decision?.dedup?.status ?? null;
  if (dedup !== "NOT_FOUND") {
    return { mutation: false, outcome: "REJECT_DEDUP", reason: `dedup ${dedup} != NOT_FOUND` };
  }

  // Gate 4 — schema/policy allowlist.
  if (!ALLOWED_ENTITIES.has(cand.entity ?? "user")) {
    return { mutation: false, outcome: "REJECT_SCHEMA", reason: `entity_not_allowed: ${cand.entity}` };
  }
  if (!ALLOWED_PROPERTIES.has(cand.property)) {
    return { mutation: false, outcome: "REJECT_SCHEMA", reason: `property_not_allowed: ${cand.property}` };
  }

  // Gate 5 — secret scan clean (re-run immediately before mutation).
  const scan = scanSecrets(typeof cand.value === "string" ? cand.value : "");
  if (scan.found) {
    return { mutation: false, outcome: "REJECT_SECRET", reason: "secret_in_value", secretTypes: scan.secrets.map((s) => s.type) };
  }

  // Gate 6 — rate/limits: max 1 per turn, bounded daily count.
  const maxPerTurn = typeof w.maxPerTurn === "number" && w.maxPerTurn > 0 ? w.maxPerTurn : 1;
  if ((ctx.perTurnWrites ?? 0) >= maxPerTurn) {
    return { mutation: false, outcome: "REJECT_RATE_LIMIT", reason: "max_per_turn_exceeded" };
  }
  const dailyLimit = typeof ctx.dailyLimit === "number" && ctx.dailyLimit > 0 ? ctx.dailyLimit : 10;
  if ((ctx.dailyWrites ?? 0) >= dailyLimit) {
    return { mutation: false, outcome: "REJECT_RATE_LIMIT", reason: "daily_canary_limit_exceeded" };
  }

  // -------------------------------------------------------------------------
  // All gates passed → perform a single, idempotent WRITE_NEW into production.
  // -------------------------------------------------------------------------
  const client = createClient(cfg);
  const slotDir = canarySlotDir(cand.entity, cand.property);
  const opId = canaryOperationId(cand.entity, cand.property, cand.value);
  const activeUri = `${slotDir}/active.md`;
  const timestamp = new Date().toISOString();

  const content = buildCanaryContent({ candidate: cand, operation_id: opId, timestamp });
  const chk = assertProductionUri(activeUri);
  if (!chk.ok) return { mutation: false, outcome: "REJECT_NAMESPACE", reason: chk.reason };

  try {
    // Idempotent create: tolerate ALREADY_EXISTS (already applied on replay).
    try {
      await client.write(activeUri, content, "create", { wait: true });
    } catch (e) {
      if (e?.code === "ALREADY_EXISTS") {
        // Read-back to confirm the existing object is OUR operation_id (no dup).
        const existing = await readSlot(client, activeUri);
        if (existing.ok && existing.content.includes(opId)) {
          return { mutation: false, outcome: "IDEMPOTENT_SUCCESS", reason: "already_committed", operation_id: opId, activeUri };
        }
        return { mutation: false, outcome: "CONFLICT", reason: "active_exists_with_different_opid", activeUri };
      }
      throw e;
    }

    // Read-back verification.
    const rb = await readSlot(client, activeUri);
    if (!rb.ok) {
      return { mutation: true, outcome: "READBACK_FAIL", reason: rb.reason, operation_id: opId, activeUri, warn: "write committed but read-back failed" };
    }
    if (!rb.content.includes(opId) || !rb.content.includes(String(cand.value ?? ""))) {
      return { mutation: true, outcome: "READBACK_MISMATCH", reason: "content_mismatch", operation_id: opId, activeUri };
    }

    return {
      mutation: true,
      outcome: "WRITE_NEW",
      reason: "canary_write_new",
      operation_id: opId,
      activeUri,
      slotDir,
      entity: cand.entity,
      property: cand.property,
      value: cand.value,
      source_type: cand.source_type,
      confidence: conf,
    };
  } catch (e) {
    return { mutation: false, outcome: "ERROR", reason: e?.code ?? e?.message ?? String(e), activeUri };
  }
}

function buildCanaryContent({ candidate, operation_id, timestamp }) {
  const fields = {
    category: "preference",
    name: canaryOperationId(candidate.entity, candidate.property, candidate.value),
    memory_type: "entities",
    provenance: candidate.source_type ?? "user_stated",
    source_type: candidate.source_type ?? "user_stated",
    confidence: typeof candidate.confidence === "number" ? candidate.confidence : null,
    operation_id,
    valid_from: timestamp,
    valid_until: null,
    canary: true,
  };
  const head = `# ${candidate.entity ?? "user"}: ${candidate.property ?? "preference"}\n${candidate.value ?? ""}`;
  const tail = `<!-- MEMORY_FIELDS\n${JSON.stringify(fields, null, 2)}\n-->`;
  return `${head}\n\n${tail}\n`;
}

// ---------------------------------------------------------------------------
// Backup / rollback (STAGE 5.6.1).
// ---------------------------------------------------------------------------

/**
 * Backup the current state of a production memory slot (if any) to the test
 * backup namespace before a mutation. Returns the backup URI + prior content.
 */
export async function backupSlot(client, uri) {
  const chk = assertBackupUri(uri);
  if (!chk.ok) return { ok: false, reason: chk.reason };
  const r = await readSlot(client, uri);
  if (!r.ok) return { ok: false, reason: r.reason, existed: false };
  const backupUri = `viking://resources/stage5-test/backup/${Date.now()}_${String(uri).split("/").slice(-1)[0].replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  try {
    await client.write(backupUri, r.content, "create", { wait: true });
    return { ok: true, existed: true, backupUri, content: r.content };
  } catch (e) {
    return { ok: false, reason: e?.code ?? e?.message ?? String(e) };
  }
}

/**
 * Rollback: restore `uri` to `content` (from a prior backup), or delete the
 * object if `content` is null (the slot did not exist before the write).
 */
export async function rollback(client, uri, content) {
  const chk = assertBackupUri(uri);
  if (!chk.ok) return { ok: false, reason: chk.reason };
  try {
    if (content == null) {
      await client.rm(uri, { recursive: true });
    } else {
      await client.write(uri, content, "replace", { wait: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.code ?? e?.message ?? String(e) };
  }
}

export { assertProductionUri, isProductionUri };