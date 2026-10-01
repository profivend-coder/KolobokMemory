// selective-memory — STAGE 5.4 write/layout.js
//
// Immutable-history layout for the isolated test-namespace writer.
//
// The on-disk / URI model is an event-store:
//   active      → answers "what do we consider current right now"
//   history/    → immutable past versions (create-only, never overwritten)
//   transitions/→ explains WHY a state changed (create-only audit records)
//   journal.json→ single source of truth for an in-flight transaction
//                 (enables idempotent recovery after a partial failure)
//
// Layout (under a run root that MUST be allowlisted):
//   <root>/slots/<slotId>/active.md
//   <root>/slots/<slotId>/history/v<version>.md
//   <root>/slots/<slotId>/journal.json
//   <root>/transitions/<ts>_<opId>.md
//
// This module is PURE: it builds URIs and content, performs NO network I/O and
// performs NO mutation. The destination is derived ONLY from (root, slotId)
// where slotId is sanitised to [a-z0-9_]; entity/property/value never influence
// the URI prefix.

import { normalizeValue } from "./normalize.js";

// ---------------------------------------------------------------------------
// Destination allowlist (the ONLY namespaces the writer may ever touch).
// ---------------------------------------------------------------------------

// Production memory namespace is deliberately ABSENT from this list. Any write
// targeting viking://user/default/memories/... is REJECTED by the writer.
// The test namespace lives under the GLOBALLY-SHARED resources scope
// (viking://resources/...) — independent knowledge, not bound to any
// account/user/agent — per the 5.4 design agreement.
export const WRITE_ALLOWLIST = [
  "viking://resources/stage5-test/",
];

// A namespace may only be extended via code/config, never via model/candidate/user.
export function resolveAllowlist(cfg = {}) {
  const list = Array.isArray(cfg.allowlist) ? cfg.allowlist : WRITE_ALLOWLIST;
  const out = [];
  for (const p of list) {
    if (typeof p === "string" && p.trim()) out.push(p.trim());
  }
  return out.length ? out : WRITE_ALLOWLIST;
}

/** True when `uri` sits under one of the allowlisted prefixes. */
export function isAllowedUri(uri, allowlist = WRITE_ALLOWLIST) {
  if (typeof uri !== "string" || !uri) return false;
  const u = uri.trim();
  for (const prefix of allowlist) {
    if (u === prefix.replace(/\/+$/, "") || u.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Reject URI tricks: no "..", no backslashes, no absolute-path fragments,
 * and no PERCENT-ENCODED traversal. The literal checks alone would let
 * `%2e%2e` / `%2F` pass (no literal dot or slash), so every segment is
 * percent-decoded and re-checked: if decoding introduces a `.` / `..` or a
 * path separator, the URI is rejected. This mirrors the server's own
 * `_reject_encoded_path_escape` (path_safety.py) so the writer's allowlist
 * gate is the first layer and the server is the second, authoritative layer.
 */
export function isSafeUri(uri) {
  if (typeof uri !== "string" || !uri) return false;
  if (
    uri.includes("..") ||
    uri.includes("\\") ||
    uri.includes(":////") ||
    uri.includes("\n") ||
    uri.includes("\r")
  ) {
    return false;
  }
  // Percent-encoded traversal: decode each segment and reject any that
  // resolves to `.` / `..` or introduces a path separator.
  for (const segment of uri.replace(/\\/g, "/").split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment; // malformed percent stays a literal segment char
    }
    if (
      decoded !== segment &&
      (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\"))
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// slotId / run-id
// ---------------------------------------------------------------------------

/** Deterministic, secret-free slot identifier from (entity, property). */
export function slotIdFor(entity, property) {
  const raw = `${String(entity ?? "user")}_${String(property ?? "preference")}`.toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 120) || "slot";
}

const HEX = "0123456789abcdef";
function randHex(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += HEX[Math.floor(Math.random() * 16)];
  return s;
}

/** Fresh run-id (used to create a brand-new test namespace, never reused). */
export function newRunId(prefix = "stage54") {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `${prefix}-${ts}-${randHex(6)}`;
}

// ---------------------------------------------------------------------------
// URI construction (pure)
// ---------------------------------------------------------------------------

export function rootUri(runId) {
  return `viking://resources/stage5-test/${runId}`;
}

export function slotDirUri(root, slotId) {
  return `${root.replace(/\/+$/, "")}/slots/${slotId}`;
}
export function activeUri(root, slotId) {
  return `${slotDirUri(root, slotId)}/active.md`;
}
export function historyUri(root, slotId, version) {
  return `${slotDirUri(root, slotId)}/history/v${version}.md`;
}
export function historyDirUri(root, slotId) {
  return `${slotDirUri(root, slotId)}/history`;
}
export function journalUri(root, slotId) {
  return `${slotDirUri(root, slotId)}/journal.json`;
}
export function transitionUri(root, opId, ts) {
  const stamp = (ts || new Date().toISOString()).replace(/[:.]/g, "-");
  return `${root.replace(/\/+$/, "")}/transitions/${stamp}_${safeFilePart(opId)}.md`;
}

function safeFilePart(s) {
  return String(s ?? "op").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
}

// ---------------------------------------------------------------------------
// MEMORY_FIELDS (tail comment block) build / parse
// ---------------------------------------------------------------------------

/**
 * Build the active-file body for a slot version.
 * The body is markdown + a `<!-- MEMORY_FIELDS {json} -->` tail. The writer
 * adds provenance / confidence / version / operation_id / supersession links so
 * the layout is traceable (design-doc §0.3 + STAGE 5 §5).
 */
export function buildActiveContent({ entity, property, value, source_type, confidence, timestamp, version, operation_id, previous_version_uri = null, superseded_versions = [], superseded_by = null, valid_from = null, valid_until = null }) {
  const fields = {
    category: "stage5-test",
    name: slotIdFor(entity, property),
    version,
    memory_type: "entities",
    provenance: source_type || "user_stated",
    source_type: source_type || "user_stated",
    confidence: typeof confidence === "number" ? confidence : null,
    operation_id: operation_id ?? null,
    valid_from: valid_from ?? timestamp ?? null,
    valid_until: valid_until ?? null,
    superseded_by: superseded_by ?? null,
    previous_version_uri: previous_version_uri ?? null,
    superseded_versions: superseded_versions ?? [],
  };
  const head = `# ${entity ?? "user"}: ${property ?? "preference"}\n${value ?? ""}`;
  const tail = `<!-- MEMORY_FIELDS\n${JSON.stringify(fields, null, 2)}\n-->`;
  return `${head}\n\n${tail}\n`;
}

/** Parse the MEMORY_FIELDS JSON from a raw content string (null if absent). */
export function parseFields(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const m = raw.match(/<!--\s*MEMORY_FIELDS\s*([\s\S]*?)-->/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/** Extract the markdown head (value body) without the MEMORY_FIELDS tail. */
export function bodyOf(raw) {
  if (typeof raw !== "string" || !raw) return "";
  return raw.replace(/<!--\s*MEMORY_FIELDS\s*[\s\S]*?-->\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// Transition record content (immutable audit: WHY a state changed)
// ---------------------------------------------------------------------------

export function buildTransitionContent({ action, operation_id, timestamp, entity, property, source_type, reason, from_version = null, to_version, old_uri = null, new_uri, old_value = null, new_value }) {
  const lines = [
    `# Transition ${operation_id}`,
    ``,
    `- action: ${action}`,
    `- operation_id: ${operation_id}`,
    `- timestamp: ${timestamp}`,
    `- slot: ${slotIdFor(entity, property)}`,
    `- entity: ${entity ?? "user"}`,
    `- property: ${property ?? "preference"}`,
    `- reason: ${reason ?? ""}`,
    `- source_type: ${source_type ?? ""}`,
    `- from_version: ${from_version ?? "null"}`,
    `- to_version: ${to_version}`,
    `- old_uri: ${old_uri ?? "null"}`,
    `- new_uri: ${new_uri}`,
  ];
  if (old_value != null) lines.push(`- old_value: ${normalizeValue(String(old_value))}`);
  if (new_value != null) lines.push(`- new_value: ${normalizeValue(String(new_value))}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Journal (in-flight transaction source of truth)
// ---------------------------------------------------------------------------

export function buildJournal({ operation_id, action, slot, from_version, new_version, entity, property, value, source_type, confidence, timestamp, old_uri, reason, status }) {
  return JSON.stringify(
    {
      operation_id,
      action,
      slot,
      from_version: from_version ?? null,
      new_version,
      entity,
      property,
      value,
      source_type: source_type ?? "user_stated",
      confidence: typeof confidence === "number" ? confidence : null,
      timestamp: timestamp ?? new Date().toISOString(),
      old_uri: old_uri ?? null,
      reason: reason ?? null,
      status: status ?? null,
    },
    null,
    2,
  );
}

export function parseJournal(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}
