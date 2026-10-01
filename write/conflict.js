// selective-memory — STAGE 5.3 write/conflict.js
//
// CONFLICT RESOLVER / DECISION ENGINE (shadow-only: NO mutation).
//
// Maps a DEDUP result (SAME / NOVEL / NOT_FOUND / AMBIGUOUS) onto one of the
// seven decision actions. Every action is a *would-* / *skip-* label — the
// decision engine never writes to OpenViking. Physical writing is STAGE 5.4+.
//
// Actions (STAGE 5.3 spec):
//   WOULD_WRITE_NEW   ← NOT_FOUND (no existing slot)
//   SKIP_DUPLICATE    ← SAME
//   SKIP_AMBIGUOUS    ← AMBIGUOUS (retrieval error / conflicting existing /
//                                 insufficient evidence)
//   WOULD_UPDATE      ← NOVEL + compatible refinement (additive, non-conflicting)
//   WOULD_SUPERSEDE   ← NOVEL + explicit user_correction (contradiction resolved)
//   SKIP_CONFLICT     ← NOVEL + contradiction, no explicit correction, equal/higher trust
//   SKIP_LOW_TRUST    ← NOVEL + contradiction, candidate trust < existing trust
//
// Critical invariants (enforced here):
//   1. no silent overwrite — only WOULD_SUPERSEDE (explicit correction) marks
//      an existing memory for invalidation, and it is never executed here.
//   2. lower-trust never replaces higher-trust → SKIP_LOW_TRUST.
//   3. retrieval failure never yields WRITE/SUPERSEDE (AMBIGUOUS → SKIP_AMBIGUOUS).
//   4. ambiguous → SKIP.
//   5. SUPERSEDE requires explicit evidence (source_type === user_correction).
//   6. the decision engine performs no mutation.

import { DEDUP_STATUS } from "./dedup.js";
import { trustOf, TRUST_CEILING } from "./trust.js";

export const DECISION = {
  WOULD_WRITE_NEW: "WOULD_WRITE_NEW",
  WOULD_UPDATE: "WOULD_UPDATE",
  WOULD_SUPERSEDE: "WOULD_SUPERSEDE",
  SKIP_DUPLICATE: "SKIP_DUPLICATE",
  SKIP_CONFLICT: "SKIP_CONFLICT",
  SKIP_LOW_TRUST: "SKIP_LOW_TRUST",
  SKIP_AMBIGUOUS: "SKIP_AMBIGUOUS",
};

// The single existing memory a NOVEL decision is compared against (the top hit).
function bestExisting(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  return evidence[0];
}

/**
 * Resolve a candidate against its dedup result into a decision.
 *
 * @param {object} candidate  { entity, property, value, source_type, confidence, ... }
 * @param {object} dedup      { status, reason, evidence } (from classifyDedup)
 * @returns {{action:string, reason:string, evidence:Array,
 *            candidate_source_type:(string|null), candidate_trust:number,
 *            existing_source_type:(string|null), existing_trust:(number|null)}}
 */
export function resolveDecision(candidate, dedup) {
  const status = dedup?.status;
  const evidence = Array.isArray(dedup?.evidence) ? dedup.evidence : [];
  const candSource = candidate?.source_type ?? null;
  const candTrust = trustOf(candSource);

  switch (status) {
    case DEDUP_STATUS.SAME:
      return { action: DECISION.SKIP_DUPLICATE, reason: "duplicate_value", evidence,
               candidate_source_type: candSource, candidate_trust: candTrust,
               existing_source_type: null, existing_trust: null };

    case DEDUP_STATUS.NOT_FOUND:
      return { action: DECISION.WOULD_WRITE_NEW, reason: "no_existing_slot", evidence,
               candidate_source_type: candSource, candidate_trust: candTrust,
               existing_source_type: null, existing_trust: null };

    case DEDUP_STATUS.AMBIGUOUS:
      // Invariant 3 & 4: retrieval failure / conflicting existing / insufficient
      // evidence → SKIP, never WRITE/SUPERSEDE.
      return { action: DECISION.SKIP_AMBIGUOUS, reason: dedup?.reason ?? "ambiguous",
               evidence, candidate_source_type: candSource, candidate_trust: candTrust,
               existing_source_type: null, existing_trust: null };

    case DEDUP_STATUS.NOVEL:
      return resolveNovel(candidate, evidence, candSource, candTrust);

    default:
      return { action: DECISION.SKIP_AMBIGUOUS, reason: "unknown_dedup_status",
               evidence, candidate_source_type: candSource, candidate_trust: candTrust,
               existing_source_type: null, existing_trust: null };
  }
}

function resolveNovel(candidate, evidence, candSource, candTrust) {
  const existing = bestExisting(evidence);
  const existingSource = existing ? existing.source_type ?? null : null;
  const existingTrust = existing ? trustOf(existing.source_type) : TRUST_CEILING.unknown;

  // Invariant 5: explicit correction is the ONLY path to SUPERSEDE.
  if (candSource === "user_correction") {
    return { action: DECISION.WOULD_SUPERSEDE, reason: "explicit_correction",
             evidence, candidate_source_type: candSource, candidate_trust: candTrust,
             existing_source_type: existingSource, existing_trust: existingTrust };
  }

  // Compatible (additive) refinement — no contradiction — may UPDATE.
  if (candSource === "user_refinement") {
    return { action: DECISION.WOULD_UPDATE, reason: "compatible_refinement",
             evidence, candidate_source_type: candSource, candidate_trust: candTrust,
             existing_source_type: existingSource, existing_trust: existingTrust };
  }

  // Contradiction without explicit correction.
  // Invariant 2: lower-trust never replaces higher-trust.
  if (candTrust < existingTrust) {
    return { action: DECISION.SKIP_LOW_TRUST, reason: "lower_trust",
             evidence, candidate_source_type: candSource, candidate_trust: candTrust,
             existing_source_type: existingSource, existing_trust: existingTrust };
  }

  // Invariant 1: no silent overwrite → surface the conflict, do not resolve it.
  return { action: DECISION.SKIP_CONFLICT, reason: "conflict_surfaced",
           evidence, candidate_source_type: candSource, candidate_trust: candTrust,
           existing_source_type: existingSource, existing_trust: existingTrust };
}

/**
 * Serialisable, secret-free decision block for the trace. Existing-memory
 * values are memory values (already sanitised upstream); never the candidate
 * raw text and never a secret.
 */
export function toDecisionBlock(result) {
  if (!result || typeof result !== "object") return null;
  return {
    action: result.action ?? null,
    reason: result.reason ?? null,
    candidate_source_type: result.candidate_source_type ?? null,
    candidate_trust: result.candidate_trust ?? null,
    existing_source_type: result.existing_source_type ?? null,
    existing_trust: result.existing_trust ?? null,
    evidence: (result.evidence ?? []).map((e) => ({
      uri: e?.uri ?? null,
      value: typeof e?.value === "string" ? e.value : null,
      source_type: e?.source_type ?? null,
    })),
  };
}
