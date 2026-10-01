// selective-memory — STAGE 5.x WRITE FOUNDATION / SHADOW MODE
//
// Orchestrator for the safe write pipeline. Physical write to OpenViking is
// FORBIDDEN (write.enabled=false): the pipeline runs end-to-end and emits a
// trace only.
//
// Pipeline:
//
//   USER/ASSISTANT TURN
//        ↓
//   [1] Secret/Safety Filter   (deterministic, redact — before any extraction)
//        ↓
//   [2] Candidate Extraction   (structured candidates from sanitised text)
//        ↓
//   [3] Write Gate             (KEEP / SKIP per candidate, reason code)
//        ↓
//   [4] DEDUP LOOKUP           (STAGE 5.2, read-only: SAME/NOVEL/AMBIGUOUS/NOT_FOUND)
//        ↓
//   [5] TRACE ONLY             (never writes to OpenViking)
//
// Feature flags (write.*):
//   enabled=false → production memory is never changed (hard safety).
//   shadow=true   → run the full decision pipeline, persist only the trace.

import { scanSecrets } from "./secret-filter.js";
import { extractCandidates } from "./extract.js";
import { classifyTurn, gateCandidate, SKIP_REASONS } from "./gate.js";
import { makeTraceEntry, serializeTrace } from "./trace.js";
import { classifyDedup, DEDUP_STATUS, FUTURE_ACTION } from "./dedup.js";
import { valueQuery, propertyQuery } from "./lookup.js";
import { resolveDecision, toDecisionBlock, DECISION } from "./conflict.js";

export const WRITE_DEFAULTS = {
  enabled: false,           // hard gate: never mutate OpenViking while false
  shadow: true,             // run decision pipeline, trace only
  lowConfidenceThreshold: 0.5,
  noiseMinChars: 1200,
};

// Candidate fields that may appear in a trace (structured only; no raw text,
// no internal `type`, and the value is already sanitised upstream).
export function toTraceCandidate(c) {
  return {
    entity: c.entity,
    property: c.property,
    value: c.value,
    source_type: c.source_type,
    confidence: c.confidence,
    timestamp: c.timestamp,
  };
}

// Shared secret-filter → extraction → write-gate stage (synchronous).
// Returns the base result object (decisions + KEEP candidates + gate-level trace).
function gateTurn(cfg, turn) {
  const c = { ...WRITE_DEFAULTS, ...(cfg || {}) };
  const timestamp = typeof turn.timestamp === "string" && turn.timestamp
    ? turn.timestamp
    : new Date().toISOString();
  const turnId = turn.turnId ?? `turn-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;

  const out = {
    turnId,
    timestamp,
    shadow: true,
    writeEnabled: c.enabled,
    inactive: false,
    secrets: [],        // secret TYPES only (never values)
    candidates: [],     // KEEP candidates only
    decisions: [],      // every considered candidate + decision/reason
    trace: [],          // serialisable trace entries
  };

  // Fully inert unless shadow (or a future real-write stage) is on.
  if (!c.enabled && !c.shadow) {
    out.inactive = true;
    return out;
  }

  const text = typeof turn.text === "string" ? turn.text : "";
  if (!text.trim()) return out;

  // [1] Secret/Safety filter — deterministic, before anything else.
  const { safeText, secrets, found } = scanSecrets(text);
  if (found) out.secrets = secrets.map((s) => s.type);

  // [2a] Text-level classification (noise rejection happens before extraction).
  const cls = classifyTurn(safeText, c);
  if (cls.isNoise) {
    out.decisions.push({ decision: "SKIP", reason: SKIP_REASONS.NOISE, candidate: null });
    out.trace.push(
      makeTraceEntry({ turnId, timestamp, decision: "SKIP", reason: SKIP_REASONS.NOISE, candidate: null, secretTypes: out.secrets }),
    );
    return out;
  }

  // [2b] Candidate extraction (sanitised text only).
  const candidates = extractCandidates(safeText, { timestamp, turnId });

  // [3] Write gate per candidate.
  for (const cand of candidates) {
    const { decision, reason } = gateCandidate(cand, cls, c);
    const tc = toTraceCandidate(cand);
    out.decisions.push({ decision, reason, candidate: tc });
    if (decision === "KEEP") out.candidates.push(tc);
    out.trace.push(
      makeTraceEntry({ turnId, timestamp, decision, reason, candidate: tc, secretTypes: out.secrets }),
    );
  }

  // A turn that contained a secret but produced no safe candidate still gets an
  // explicit audit record (secret TYPE only, never the value).
  if (found && candidates.length === 0) {
    out.decisions.push({ decision: "SKIP", reason: SKIP_REASONS.SECRET, candidate: null });
    out.trace.push(
      makeTraceEntry({ turnId, timestamp, decision: "SKIP", reason: SKIP_REASONS.SECRET, candidate: null, secretTypes: out.secrets }),
    );
  }

  return out;
}

/**
 * STAGE 5.1 entry — synchronous shadow pipeline WITHOUT dedup (extraction +
 * gate + trace only). Kept for backward compatibility with the 5.1 contract.
 */
export function runShadowPipeline(cfg = {}, turn = {}) {
  return gateTurn(cfg, turn);
}

/**
 * STAGE 5.2 entry — asynchronous shadow pipeline WITH read-only dedup lookup.
 *
 * @param {object} cfg  write config
 * @param {{turnId?: string, text?: string, timestamp?: string}} turn
 * @param {(candidate: object) => Promise<{byValue:object, byProperty:object}>} [lookup]
 *        Read-only lookup. Defaults to null → every KEEP candidate is recorded
 *        as AMBIGUOUS ("lookup_unavailable"), never NOT_FOUND.
 * @returns {Promise<object>} shadow result with per-KEEP dedup block in trace.
 */
export async function runDedupPipeline(cfg = {}, turn = {}, lookup = null) {
  const base = gateTurn(cfg, turn);
  if (base.inactive || base.candidates.length === 0) return base;

  // KEEP trace entries correspond, in order, to base.candidates.
  const keepEntries = base.trace.filter((t) => t.decision === "KEEP");

  for (let i = 0; i < base.candidates.length; i++) {
    const cand = base.candidates[i];
    let result;
    try {
      if (lookup) {
        const looked = await lookup(cand);
        result = classifyDedup(cand, looked);
      } else {
        result = { status: DEDUP_STATUS.AMBIGUOUS, reason: "lookup_unavailable", evidence: [], error: "no lookup configured" };
      }
    } catch (e) {
      result = { status: DEDUP_STATUS.AMBIGUOUS, reason: "retrieval_error", evidence: [], error: e?.message ?? String(e) };
    }

    const dedupBlock = {
      status: result.status,
      reason: result.reason,
      query: { value: valueQuery(cand), property: propertyQuery(cand) },
      evidence: Array.isArray(result.evidence) ? result.evidence : [],
      future_action: FUTURE_ACTION[result.status] ?? null,
    };
    if (result.error) dedupBlock.error = result.error;

    const entry = keepEntries[i];
    if (entry) entry.dedup = dedupBlock;
  }

  return base;
}

/**
 * STAGE 5.3 entry — asynchronous shadow pipeline with read-only dedup lookup
 * AND conflict resolution (decision engine). Never mutates: it only attaches
 * a `write_decision` block (WOULD_* / SKIP_*) to each KEEP trace entry.
 *
 * @param {object} cfg  write config
 * @param {{turnId?: string, text?: string, timestamp?: string}} turn
 * @param {(candidate: object) => Promise<{byValue:object, byProperty:object}>} [lookup]
 * @returns {Promise<object>} shadow result with per-KEEP `dedup` + `write_decision`.
 */
export async function runDecisionPipeline(cfg = {}, turn = {}, lookup = null) {
  const base = await runDedupPipeline(cfg, turn, lookup);
  if (base.inactive || base.candidates.length === 0) return base;

  const keepEntries = base.trace.filter((t) => t.decision === "KEEP");

  for (let i = 0; i < base.candidates.length; i++) {
    const cand = base.candidates[i];
    const entry = keepEntries[i];
    // If dedup was missing (should not happen), fail-closed into AMBIGUOUS.
    const dedup = entry?.dedup ?? {
      status: DEDUP_STATUS.AMBIGUOUS,
      reason: "missing_dedup",
      evidence: [],
    };
    const decision = resolveDecision(cand, dedup);
    const block = toDecisionBlock(decision);
    if (entry) entry.write_decision = block;
  }

  return base;
}

export {
  scanSecrets,
  extractCandidates,
  classifyTurn,
  gateCandidate,
  SKIP_REASONS,
  serializeTrace,
  classifyDedup,
  DEDUP_STATUS,
  FUTURE_ACTION,
  valueQuery,
  propertyQuery,
  resolveDecision,
  toDecisionBlock,
  DECISION,
};
