// selective-memory — STAGE 5.3 write/trust.js
//
// Trust ladder (source_type → confidence ceiling), taken verbatim from the
// STAGE 5 design doc §3 ("Trust ladder (из A)"):
//
//   user_correction  0.99
//   user_stated      0.95
//   external_doc     0.70
//   agent_inferred   0.60
//   llm_summarized   0.50
//
// Two additions needed by the write path (documented here, not silent):
//   - user_refinement 0.95 — an additive user statement ("также/ещё/плюс X").
//     It is a subtype of user_stated and inherits its trust: it is still an
//     explicit user assertion, so it may UPDATE but never silently overwrite.
//   - unknown          0.0 — a memory with NO provenance fields. Current
//     OpenViking files only carry `version` + `source_extraction_id`; the
//     provenance/confidence fields are added by STAGE 5 (writer). Until then
//     an existing memory is treated as lowest trust — never trusted to beat a
//     user statement, but never blindly overwritten either (conflict resolver
//     still fail-closes unless the correction is explicit).

export const TRUST_CEILING = {
  user_correction: 0.99,
  user_stated: 0.95,
  user_refinement: 0.95,
  external_doc: 0.70,
  agent_inferred: 0.60,
  llm_summarized: 0.50,
  unknown: 0.0,
};

/** Trust ceiling for a source_type; unknown/absent → 0.0. */
export function trustOf(sourceType) {
  if (typeof sourceType !== "string") return TRUST_CEILING.unknown;
  return TRUST_CEILING[sourceType] ?? TRUST_CEILING.unknown;
}

/** Is this source a direct user assertion (vs machine/inferred)? */
export function isUserSource(sourceType) {
  return (
    sourceType === "user_correction" ||
    sourceType === "user_stated" ||
    sourceType === "user_refinement"
  );
}
