import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyDedup, DEDUP_STATUS, FUTURE_ACTION, isSidecar } from "../write/dedup.js";
import { normalizeValue, valuesEquivalent, isSimilar } from "../write/normalize.js";
import { valueQuery, propertyQuery } from "../write/lookup.js";
import { runDedupPipeline, WRITE_DEFAULTS } from "../write/index.js";

// ---------------------------------------------------------------------------
// STAGE 5.2 — DEDUP + EXISTING MEMORY LOOKUP
// ---------------------------------------------------------------------------

// Helper to build a memory hit the way openvikingFind returns them.
function mem({ uri, property, value, score = 0.8, text = "" }) {
  const m = { uri, score };
  if (property) m.property = property;
  if (value) m.value = value;
  if (text) m.text = text;
  return m;
}

const CAND = { entity: "user", property: "preferred_editor", value: "VS Code" };

function okLookup(byValueMemories, byPropertyMemories) {
  return {
    byValue: { ok: true, error: null, memories: byValueMemories ?? [] },
    byProperty: { ok: true, error: null, memories: byPropertyMemories ?? [] },
  };
}

// ---------------------------------------------------------------------------
// A. SAME
// ---------------------------------------------------------------------------
test("A: preferred_editor=VS Code vs existing VS Code → SAME", () => {
  const r = classifyDedup(CAND, okLookup(
    [mem({ uri: "viking://mem/editor.md", property: "preferred_editor", value: "VS Code" })],
    [],
  ));
  assert.equal(r.status, DEDUP_STATUS.SAME);
  assert.equal(FUTURE_ACTION[r.status], "SKIP_DUPLICATE");
  assert.equal(r.evidence.length, 1);
});

// ---------------------------------------------------------------------------
// B. NOVEL
// ---------------------------------------------------------------------------
test("B: VS Code vs existing Cursor → NOVEL", () => {
  const r = classifyDedup(CAND, okLookup(
    [],
    [mem({ uri: "viking://mem/editor.md", property: "preferred_editor", value: "Cursor" })],
  ));
  assert.equal(r.status, DEDUP_STATUS.NOVEL);
  assert.equal(FUTURE_ACTION[r.status], "DEFER_CONFLICT_CHECK");
});

// ---------------------------------------------------------------------------
// C. NOT_FOUND
// ---------------------------------------------------------------------------
test("C: nothing found → NOT_FOUND", () => {
  const r = classifyDedup(CAND, okLookup([], []));
  assert.equal(r.status, DEDUP_STATUS.NOT_FOUND);
  assert.equal(FUTURE_ACTION[r.status], "WOULD_WRITE_NEW");
});

// ---------------------------------------------------------------------------
// D. multiple contradictory existing → AMBIGUOUS
// ---------------------------------------------------------------------------
test("D: two different existing values under same property → AMBIGUOUS", () => {
  const r = classifyDedup(CAND, okLookup(
    [],
    [
      mem({ uri: "viking://mem/e1.md", property: "preferred_editor", value: "Cursor" }),
      mem({ uri: "viking://mem/e2.md", property: "preferred_editor", value: "Vim" }),
    ],
  ));
  assert.equal(r.status, DEDUP_STATUS.AMBIGUOUS);
  assert.equal(r.reason, "conflicting_existing");
});

// ---------------------------------------------------------------------------
// E. only sidecar matches → NOT_FOUND
// ---------------------------------------------------------------------------
test("E: only .overview.md/.abstract.md → NOT_FOUND", () => {
  const r = classifyDedup(CAND, okLookup(
    [mem({ uri: "viking://mem/.overview.md", value: "VS Code", text: "VS Code" })],
    [mem({ uri: "viking://mem/.abstract.md", value: "VS Code", text: "VS Code" })],
  ));
  assert.equal(r.status, DEDUP_STATUS.NOT_FOUND);
  assert.equal(r.evidence.length, 0);
});

test("isSidecar: detects sidecar URIs", () => {
  assert.equal(isSidecar("viking://mem/.overview.md"), true);
  assert.equal(isSidecar("viking://mem/.abstract.md"), true);
  assert.equal(isSidecar("viking://mem/editor.md"), false);
});

// ---------------------------------------------------------------------------
// F. high semantic score but different property → NOT SAME
// ---------------------------------------------------------------------------
test("F: high score, different property → NOT_FOUND (not SAME)", () => {
  const r = classifyDedup(CAND, okLookup(
    [mem({ uri: "viking://mem/ide.md", property: "preferred_ide", value: "VS Code", score: 0.99 })],
    [],
  ));
  // Different property → excluded from evidence entirely → NOT_FOUND.
  assert.equal(r.status, DEDUP_STATUS.NOT_FOUND);
  assert.notEqual(r.status, DEDUP_STATUS.SAME);
});

// ---------------------------------------------------------------------------
// G. case/whitespace normalization → SAME
// ---------------------------------------------------------------------------
test("G: 'VS Code' vs '  vs  code  ' → SAME", () => {
  const r = classifyDedup(CAND, okLookup(
    [mem({ uri: "viking://mem/editor.md", property: "preferred_editor", value: "  vs  code  " })],
    [],
  ));
  assert.equal(r.status, DEDUP_STATUS.SAME);
});

// ---------------------------------------------------------------------------
// H. similar but not provably equal → AMBIGUOUS
// ---------------------------------------------------------------------------
test("H: similar value (substring/overlap) → AMBIGUOUS (fail-closed)", () => {
  // "Visual Studio Code" contains "vs code"? No token overlap in normalize
  // (tokens: [visual,studio,code] vs [vs,code]) → 1/2 = 0.5 → isSimilar true → AMBIGUOUS.
  const r = classifyDedup(CAND, okLookup(
    [mem({ uri: "viking://mem/editor.md", property: "preferred_editor", value: "Visual Studio Code" })],
    [],
  ));
  assert.equal(r.status, DEDUP_STATUS.AMBIGUOUS);
});

// ---------------------------------------------------------------------------
// I. secret-containing turn → secret absent from query/evidence/trace
// ---------------------------------------------------------------------------
test("I: secret redacted, absent from dedup query + trace", async () => {
  const key = "sk-live-SECRETMARKER123456";
  const seen = { query: null, trace: null };
  const lookup = async (cand) => {
    seen.query = { value: valueQuery(cand), property: propertyQuery(cand) };
    return okLookup([], []);
  };
  const r = await runDedupPipeline(WRITE_DEFAULTS, {
    turnId: "t-i",
    text: `Я предпочитаю VS Code, мой API key ${key}`,
  }, lookup);

  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].value, "VS Code");
  // The secret must never appear in the query built for lookup.
  assert.ok(!JSON.stringify(seen.query).includes(key));
  assert.ok(!JSON.stringify(seen.query).includes("SECRETMARKER123456"));
  // Nor in the full trace.
  assert.ok(!JSON.stringify(r.trace).includes(key));
  // But the secret TYPE is recorded.
  const keep = r.trace.find((t) => t.decision === "KEEP");
  assert.ok(keep.secret_types.includes("api_key"));
  // And the dedup block is present.
  assert.ok(keep.dedup && keep.dedup.status === DEDUP_STATUS.NOT_FOUND);
});

// ---------------------------------------------------------------------------
// J. OpenViking unavailable / malformed → AMBIGUOUS (not NOT_FOUND)
// ---------------------------------------------------------------------------
test("J: retrieval error → AMBIGUOUS, never NOT_FOUND", () => {
  const r = classifyDedup(CAND, {
    byValue: { ok: false, error: "timeout", memories: [] },
    byProperty: { ok: true, error: null, memories: [] },
  });
  assert.equal(r.status, DEDUP_STATUS.AMBIGUOUS);
  assert.equal(r.reason, "retrieval_error");
  assert.notEqual(r.status, DEDUP_STATUS.NOT_FOUND);
});

test("J2: malformed lookup (missing ok flags) → AMBIGUOUS", () => {
  const r = classifyDedup(CAND, { byValue: {}, byProperty: {} });
  assert.equal(r.status, DEDUP_STATUS.AMBIGUOUS);
});

test("J3: runDedupPipeline with no lookup → AMBIGUOUS (lookup_unavailable)", async () => {
  const r = await runDedupPipeline(WRITE_DEFAULTS, { turnId: "t-j3", text: "Я предпочитаю VS Code" });
  assert.equal(r.candidates.length, 1);
  const keep = r.trace.find((t) => t.decision === "KEEP");
  assert.equal(keep.dedup.status, DEDUP_STATUS.AMBIGUOUS);
  assert.equal(keep.dedup.reason, "lookup_unavailable");
});

test("J4: runDedupPipeline propagates lookup throw → AMBIGUOUS", async () => {
  const lookup = async () => { throw new Error("boom"); };
  const r = await runDedupPipeline(WRITE_DEFAULTS, { turnId: "t-j4", text: "Я предпочитаю VS Code" }, lookup);
  const keep = r.trace.find((t) => t.decision === "KEEP");
  assert.equal(keep.dedup.status, DEDUP_STATUS.AMBIGUOUS);
  assert.equal(keep.dedup.reason, "retrieval_error");
});

// ---------------------------------------------------------------------------
// normalization unit tests
// ---------------------------------------------------------------------------
test("normalizeValue: case, spaces, ё, quotes, punctuation", () => {
  assert.equal(normalizeValue("  VS Code!  "), "vs code");
  assert.equal(normalizeValue("Ёжик"), "ежик");
  assert.equal(normalizeValue('"Hello"'), "hello");
  assert.equal(normalizeValue("  — yes — "), "yes");
});

test("valuesEquivalent: normalizes both sides", () => {
  assert.equal(valuesEquivalent("VS Code", "vs code"), true);
  assert.equal(valuesEquivalent("VS Code", "Cursor"), false);
});

test("isSimilar: conservative substring/token overlap", () => {
  assert.equal(isSimilar("VS Code", "Visual Studio Code"), true); // 1/2 overlap
  assert.equal(isSimilar("VS Code", "Python"), false);
});

// ---------------------------------------------------------------------------
// query builders
// ---------------------------------------------------------------------------
test("valueQuery / propertyQuery: correct shape", () => {
  assert.equal(valueQuery(CAND), "user preferred_editor VS Code");
  assert.equal(propertyQuery(CAND), "user preferred_editor");
});
