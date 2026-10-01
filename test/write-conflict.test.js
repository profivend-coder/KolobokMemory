// STAGE 5.3 — CONFLICT RESOLVER / DECISION ENGINE (shadow-only)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveDecision, toDecisionBlock, DECISION,
} from "../write/conflict.js";
import { trustOf, TRUST_CEILING } from "../write/trust.js";
import { classifyDedup, DEDUP_STATUS } from "../write/dedup.js";
import { runDecisionPipeline, WRITE_DEFAULTS } from "../write/index.js";

function mem({ uri, property, value, score = 0.8, source_type = null }) {
  const m = { uri, score };
  if (property) m.property = property;
  if (value) m.value = value;
  if (source_type) m.source_type = source_type;
  return m;
}

function okLookup(byValue = [], byProperty = []) {
  return {
    byValue: { ok: true, error: null, memories: byValue },
    byProperty: { ok: true, error: null, memories: byProperty },
  };
}

const CAND = { entity: "user", property: "preferred_editor", value: "VS Code", source_type: "user_stated" };

// ---------------------------------------------------------------------------
// A. SAME → SKIP_DUPLICATE
// ---------------------------------------------------------------------------
test("A: SAME → SKIP_DUPLICATE", () => {
  const dedup = classifyDedup(CAND, okLookup(
    [mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "VS Code" })],
    [],
  ));
  const r = resolveDecision(CAND, dedup);
  assert.equal(r.action, DECISION.SKIP_DUPLICATE);
  assert.equal(r.reason, "duplicate_value");
});

// ---------------------------------------------------------------------------
// B. NOT_FOUND → WOULD_WRITE_NEW
// ---------------------------------------------------------------------------
test("B: NOT_FOUND → WOULD_WRITE_NEW", () => {
  const dedup = classifyDedup(CAND, okLookup([], []));
  const r = resolveDecision(CAND, dedup);
  assert.equal(r.action, DECISION.WOULD_WRITE_NEW);
  assert.equal(r.reason, "no_existing_slot");
});

// ---------------------------------------------------------------------------
// C. AMBIGUOUS (retrieval error) → SKIP_AMBIGUOUS, never WRITE/SUPERSEDE
// ---------------------------------------------------------------------------
test("C: AMBIGUOUS retrieval error → SKIP_AMBIGUOUS", () => {
  const dedup = classifyDedup(CAND, {
    byValue: { ok: false, error: "timeout", memories: [] },
    byProperty: { ok: true, error: null, memories: [] },
  });
  const r = resolveDecision(CAND, dedup);
  assert.equal(r.action, DECISION.SKIP_AMBIGUOUS);
  assert.notEqual(r.action, DECISION.WOULD_WRITE_NEW);
  assert.notEqual(r.action, DECISION.WOULD_SUPERSEDE);
});

// ---------------------------------------------------------------------------
// D. NOVEL + lower-trust candidate → SKIP_LOW_TRUST
// ---------------------------------------------------------------------------
test("D: NOVEL + lower trust → SKIP_LOW_TRUST", () => {
  const cand = { ...CAND, source_type: "agent_inferred" }; // 0.60
  const dedup = classifyDedup(cand, okLookup([], [
    mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "Cursor", source_type: "user_stated" }),
  ]));
  assert.equal(dedup.status, DEDUP_STATUS.NOVEL);
  const r = resolveDecision(cand, dedup);
  assert.equal(r.action, DECISION.SKIP_LOW_TRUST);
  assert.equal(r.reason, "lower_trust");
});

// ---------------------------------------------------------------------------
// E. NOVEL + contradiction, no correction, equal trust → SKIP_CONFLICT
// ---------------------------------------------------------------------------
test("E: NOVEL + contradiction (no correction) → SKIP_CONFLICT", () => {
  const dedup = classifyDedup(CAND, okLookup([], [
    mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "Cursor", source_type: "user_stated" }),
  ]));
  assert.equal(dedup.status, DEDUP_STATUS.NOVEL);
  const r = resolveDecision(CAND, dedup);
  assert.equal(r.action, DECISION.SKIP_CONFLICT);
  assert.equal(r.reason, "conflict_surfaced");
});

// ---------------------------------------------------------------------------
// F. NOVEL + explicit user_correction → WOULD_SUPERSEDE
// ---------------------------------------------------------------------------
test("F: NOVEL + user_correction → WOULD_SUPERSEDE", () => {
  const cand = { ...CAND, source_type: "user_correction" };
  const dedup = classifyDedup(cand, okLookup([], [
    mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "Cursor", source_type: "user_stated" }),
  ]));
  assert.equal(dedup.status, DEDUP_STATUS.NOVEL);
  const r = resolveDecision(cand, dedup);
  assert.equal(r.action, DECISION.WOULD_SUPERSEDE);
  assert.equal(r.reason, "explicit_correction");
});

// ---------------------------------------------------------------------------
// G. conflicting existing memories → dedup AMBIGUOUS → SKIP_AMBIGUOUS
// ---------------------------------------------------------------------------
test("G: conflicting existing → SKIP_AMBIGUOUS", () => {
  const dedup = classifyDedup(CAND, okLookup([], [
    mem({ uri: "viking://mem/e1.md", property: "preferred_editor", value: "Cursor" }),
    mem({ uri: "viking://mem/e2.md", property: "preferred_editor", value: "Vim" }),
  ]));
  assert.equal(dedup.status, DEDUP_STATUS.AMBIGUOUS);
  const r = resolveDecision(CAND, dedup);
  assert.equal(r.action, DECISION.SKIP_AMBIGUOUS);
});

// ---------------------------------------------------------------------------
// H. compatible refinement → WOULD_UPDATE
// ---------------------------------------------------------------------------
test("H: NOVEL + user_refinement → WOULD_UPDATE", () => {
  const cand = { ...CAND, source_type: "user_refinement" };
  const dedup = classifyDedup(cand, okLookup([], [
    mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "Cursor", source_type: "user_stated" }),
  ]));
  assert.equal(dedup.status, DEDUP_STATUS.NOVEL);
  const r = resolveDecision(cand, dedup);
  assert.equal(r.action, DECISION.WOULD_UPDATE);
  assert.equal(r.reason, "compatible_refinement");
});

// ---------------------------------------------------------------------------
// I. historical fact: "Раньше Cursor, теперь VS Code" — historical value must
//    not become current memory; only the correction is a candidate.
// ---------------------------------------------------------------------------
test("I: 'Раньше Cursor, теперь VS Code' → only current value, no historical", async () => {
  const r = await runDecisionPipeline(WRITE_DEFAULTS, {
    turnId: "t-i",
    text: "Раньше использовал Cursor, теперь VS Code",
  }, null);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].value, "VS Code");
  assert.equal(r.candidates[0].source_type, "user_correction");
  const serialized = JSON.stringify(r.trace);
  assert.ok(!serialized.includes("Cursor"), "historical value must not appear in trace");
});

// ---------------------------------------------------------------------------
// J. secret + explicit correction → secret absent from entire conflict trace
// ---------------------------------------------------------------------------
test("J: secret + explicit correction → secret absent from conflict trace", async () => {
  const key = "sk-live-CONFLICTSECRET987654";
  const r = await runDecisionPipeline(WRITE_DEFAULTS, {
    turnId: "t-j",
    text: `теперь VS Code, мой API key ${key}`,
  }, null);
  assert.ok(r.secrets.includes("api_key"));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].value, "VS Code");
  const serialized = JSON.stringify(r.trace);
  assert.ok(!serialized.includes(key));
  assert.ok(!serialized.includes("CONFLICTSECRET987654"));
});

// ---------------------------------------------------------------------------
// Pipeline: write_decision block attached to KEEP trace entry
// ---------------------------------------------------------------------------
test("pipeline: write_decision attached to KEEP trace entry", async () => {
  const lookup = async () => okLookup(
    [mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "VS Code" })],
    [],
  );
  const r = await runDecisionPipeline(WRITE_DEFAULTS, {
    turnId: "t-p",
    text: "Я предпочитаю VS Code",
  }, lookup);
  assert.equal(r.candidates.length, 1);
  const keep = r.trace.find((t) => t.decision === "KEEP");
  assert.ok(keep.write_decision, "KEEP trace entry must carry write_decision");
  assert.equal(keep.write_decision.action, DECISION.SKIP_DUPLICATE);
  assert.equal(keep.write_decision.candidate_source_type, "user_stated");
});

// ---------------------------------------------------------------------------
// Invariant: decision engine performs NO mutation (no write fields in block)
// ---------------------------------------------------------------------------
test("invariant: decision block contains no mutation fields", () => {
  const dedup = classifyDedup(CAND, okLookup([], []));
  const block = toDecisionBlock(resolveDecision(CAND, dedup));
  const keys = Object.keys(block);
  for (const k of ["content", "mode", "method", "uri", "write", "update", "supersede"]) {
    assert.ok(!keys.includes(k), `block must not carry "${k}"`);
  }
  assert.equal(block.action, DECISION.WOULD_WRITE_NEW);
});

// ---------------------------------------------------------------------------
// trust ladder
// ---------------------------------------------------------------------------
test("trustOf: ladder + unknown fallback", () => {
  assert.equal(trustOf("user_correction"), 0.99);
  assert.equal(trustOf("user_stated"), 0.95);
  assert.equal(trustOf("agent_inferred"), 0.60);
  assert.equal(trustOf("llm_summarized"), 0.50);
  assert.equal(trustOf("unknown"), 0.0);
  assert.equal(trustOf(undefined), 0.0);
  assert.equal(TRUST_CEILING.external_doc, 0.70);
});

// ---------------------------------------------------------------------------
// All seven decision codes are reachable
// ---------------------------------------------------------------------------
test("DECISION: all seven codes defined", () => {
  assert.deepEqual(Object.keys(DECISION).sort(), [
    "SKIP_AMBIGUOUS", "SKIP_CONFLICT", "SKIP_DUPLICATE", "SKIP_LOW_TRUST",
    "WOULD_SUPERSEDE", "WOULD_UPDATE", "WOULD_WRITE_NEW",
  ].sort());
});
