// selective-memory — STAGE 5.2 write/dedup.js
//
// Dedup classification over read-only lookup results. Fail-closed:
// any uncertainty → AMBIGUOUS. NOVEL is only a *signal* for the future
// STAGE 5.3 conflict resolver — it does NOT mean UPDATE/SUPERSEDE yet.
//
// Contract: classifyDedup(candidate, { byValue, byProperty })
//   → { status: SAME|NOVEL|NOT_FOUND|AMBIGUOUS, reason, evidence }
//
// A high semantic score alone never yields SAME: property/value must be
// confirmed against the found memory's content.

import { normalizeValue, valuesEquivalent, isSimilar } from "./normalize.js";

export const DEDUP_STATUS = {
  SAME: "SAME",
  NOVEL: "NOVEL",
  NOT_FOUND: "NOT_FOUND",
  AMBIGUOUS: "AMBIGUOUS",
};

// Future (not-yet-executed) action hints. None of these are performed in
// STAGE 5.2 — they are recorded in the trace only.
export const FUTURE_ACTION = {
  SAME: "SKIP_DUPLICATE",
  NOVEL: "DEFER_CONFLICT_CHECK",
  NOT_FOUND: "WOULD_WRITE_NEW",
  AMBIGUOUS: "SKIP_AMBIGUOUS",
};

// Same sidecar rule as STAGE 4.4 (redeclared here, in the write module, so the
// production read-path index.js stays untouched).
const SIDECAR_SUFFIXES = ["/.overview.md", "/.abstract.md"];
export function isSidecar(uri) {
  return typeof uri === "string" && SIDECAR_SUFFIXES.some((s) => uri.endsWith(s));
}

function textOf(mem) {
  if (!mem || typeof mem !== "object") return "";
  for (const k of ["content", "text", "summary", "abstract", "value"]) {
    if (typeof mem[k] === "string" && mem[k].trim()) return mem[k];
  }
  return "";
}

function normProp(p) {
  return typeof p === "string" ? p.trim().toLowerCase() : "";
}

// Is the found memory about the SAME property as the candidate?
//   "same"   → confident same property (structured field or token present)
//   "other"  → confident different property (structured field only)
//   "unknown"→ cannot confirm (→ fail-closed AMBIGUOUS in classification)
function matchProperty(mem, candidateProperty) {
  if (mem && typeof mem.property === "string" && mem.property.trim()) {
    return normProp(mem.property) === normProp(candidateProperty) ? "same" : "other";
  }
  const token = normProp(candidateProperty).replace(/^preferred_/, "");
  if (token.length >= 3) {
    const hay = `${mem?.uri ?? ""} ${textOf(mem)}`.toLowerCase();
    if (hay.includes(token)) return "same";
  }
  return "unknown";
}

function extractValue(mem) {
  if (mem && typeof mem.value === "string" && mem.value.trim()) return mem.value;
  return textOf(mem);
}

/**
 * Classify a KEEP candidate against read-only lookup results.
 * @param {object} candidate  { entity, property, value, ... }
 * @param {{byValue: object, byProperty: object}} lookups
 * @returns {{status: string, reason: string, evidence: Array, error?: string}}
 */
export function classifyDedup(candidate, { byValue, byProperty }) {
  // Any retrieval failure → AMBIGUOUS, never NOT_FOUND (an error is not proof
  // that the memory is absent).
  const errs = [];
  if (!byValue?.ok) errs.push(`value:${byValue?.error ?? "failed"}`);
  if (!byProperty?.ok) errs.push(`property:${byProperty?.error ?? "failed"}`);
  if (errs.length) {
    return { status: DEDUP_STATUS.AMBIGUOUS, reason: "retrieval_error", evidence: [], error: errs.join("; ") };
  }

  const nv = normalizeValue(candidate?.value);
  const seen = new Set();
  const sameHits = [];
  const diffHits = [];
  const unknownHits = [];

  for (const mem of [...(byValue?.memories ?? []), ...(byProperty?.memories ?? [])]) {
    const uri = typeof mem?.uri === "string" ? mem.uri : "";
    if (isSidecar(uri)) continue;        // sidecar → never evidence (STAGE 4.4 rule)
    if (!uri && !textOf(mem)) continue;
    if (uri) {
      if (seen.has(uri)) continue;       // de-dupe merged value+property results
      seen.add(uri);
    }

    const prop = matchProperty(mem, candidate?.property);
    if (prop === "other") continue;      // high score, different property → not evidence

    const rawVal = extractValue(mem);
    const nv2 = normalizeValue(rawVal);
    const ev = { uri: uri || null, score: mem?.score ?? null, property: mem?.property ?? null, value: rawVal, source_type: mem?.source_type ?? null };

    if (prop === "same") {
      if (nv2 && valuesEquivalent(nv, nv2)) sameHits.push(ev);
      else if (nv2 && isSimilar(nv, nv2)) unknownHits.push({ ...ev, matched: "similar_value" });
      else if (nv2) diffHits.push(ev);
      else unknownHits.push(ev);
    } else {
      unknownHits.push(ev);              // cannot confirm property → ambiguous
    }
  }

  const all = [...sameHits, ...diffHits, ...unknownHits];

  if (all.length === 0) {
    return { status: DEDUP_STATUS.NOT_FOUND, reason: "no_matching_memory", evidence: [] };
  }

  // Multiple clearly-different values under the same property → contradictory
  // existing memory → cannot decide safely.
  if (diffHits.length >= 1) {
    const distinct = new Set(diffHits.map((h) => normalizeValue(h.value)));
    if (distinct.size >= 2) {
      return { status: DEDUP_STATUS.AMBIGUOUS, reason: "conflicting_existing", evidence: diffHits };
    }
  }

  if (sameHits.length >= 1 && diffHits.length === 0 && unknownHits.length === 0) {
    return { status: DEDUP_STATUS.SAME, reason: "duplicate_value", evidence: sameHits };
  }

  if (sameHits.length === 0 && diffHits.length === 1 && unknownHits.length === 0) {
    return { status: DEDUP_STATUS.NOVEL, reason: "different_value", evidence: diffHits };
  }

  return { status: DEDUP_STATUS.AMBIGUOUS, reason: "insufficient_evidence", evidence: all };
}
