// selective-memory — STAGE 5.1 write/trace.js
//
// Write-decision trace. A trace entry records WHAT was decided and WHY, but
// never the original secret: the pipeline only ever feeds sanitised candidate
// values here, and `secret_types` records types (not values) of what was
// redacted upstream.

/**
 * Build a trace entry for one considered candidate (or a text-level rejection).
 * @param {{turnId:string, timestamp:string, decision:"KEEP"|"SKIP", reason:string|null,
 *          candidate:object|null, secretTypes:string[], dedup?:object}} p
 * @returns {object}
 */
export function makeTraceEntry({ turnId, timestamp, decision, reason, candidate, secretTypes, dedup, write_decision }) {
  const e = {
    turn_id: turnId ?? "",
    timestamp: timestamp ?? new Date().toISOString(),
    decision,
    reason: reason ?? null,
    candidate: candidate ? { ...candidate } : null,
    secret_types: Array.isArray(secretTypes) ? [...secretTypes] : [],
  };
  if (dedup && typeof dedup === "object") e.dedup = dedup;
  if (write_decision && typeof write_decision === "object") e.write_decision = write_decision;
  return e;
}

/** Serialize one trace entry as a single JSON line. */
export function serializeTraceEntry(entry) {
  return JSON.stringify(entry);
}

/** Serialize an array of trace entries to JSONL (no trailing partial line). */
export function serializeTrace(entries) {
  const lines = (entries ?? []).map(serializeTraceEntry);
  return lines.length ? lines.join("\n") + "\n" : "";
}
