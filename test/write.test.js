import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runShadowPipeline,
  WRITE_DEFAULTS,
  SKIP_REASONS,
} from "../write/index.js";
import { scanSecrets, REDACTED } from "../write/secret-filter.js";
import { extractCandidates } from "../write/extract.js";
import { classifyTurn, gateCandidate } from "../write/gate.js";

// ---------------------------------------------------------------------------
// STAGE 5.1 — WRITE FOUNDATION / SHADOW MODE
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A. "Я предпочитаю VS Code" → candidate / KEEP
// ---------------------------------------------------------------------------
test("A: preference → KEEP candidate (property preferred_editor)", () => {
  const r = runShadowPipeline(WRITE_DEFAULTS, {
    turnId: "t-a",
    text: "Я предпочитаю VS Code",
  });
  assert.equal(r.shadow, true);
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.equal(c.property, "preferred_editor");
  assert.equal(c.value, "VS Code");
  assert.equal(c.source_type, "user_stated");
  assert.equal(c.entity, "user");
  assert.ok(typeof c.confidence === "number" && c.confidence >= 0.5);
  assert.equal(r.decisions[0].decision, "KEEP");
  assert.equal(r.decisions[0].reason, null);
});

// ---------------------------------------------------------------------------
// B. "Сегодня дождь" → SKIP TEMPORARY / NO_LONG_TERM_VALUE
// ---------------------------------------------------------------------------
test("B: transient weather → SKIP TEMPORARY", () => {
  const r = runShadowPipeline(WRITE_DEFAULTS, {
    turnId: "t-b",
    text: "Сегодня дождь",
  });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].decision, "SKIP");
  assert.equal(r.decisions[0].reason, SKIP_REASONS.TEMPORARY);
});

// ---------------------------------------------------------------------------
// C. API key → secret never reaches candidate or trace
// ---------------------------------------------------------------------------
test("C: API key → no secret in candidate or trace", () => {
  const key = "sk-abcdef1234567890ABCDEF";
  const r = runShadowPipeline(WRITE_DEFAULTS, {
    turnId: "t-c",
    text: `вот мой ключ ${key}`,
  });
  assert.ok(r.secrets.includes("api_key"));
  // Nothing should be kept from a pure-secret turn.
  assert.equal(r.candidates.length, 0);
  // Trace must not contain the raw key anywhere.
  const serialized = JSON.stringify(r.trace);
  assert.ok(!serialized.includes(key), "raw API key leaked into trace");
  assert.ok(!serialized.includes("abcdef1234567890"));
  // Redacted marker may appear, but never the value.
});

// ---------------------------------------------------------------------------
// D. password → same
// ---------------------------------------------------------------------------
test("D: password → no secret in candidate or trace", () => {
  const pwd = "hunter2secret";
  const r = runShadowPipeline(WRITE_DEFAULTS, {
    turnId: "t-d",
    text: `пароль: ${pwd}`,
  });
  assert.ok(r.secrets.includes("credential_assignment") || r.secrets.includes("password"));
  assert.equal(r.candidates.length, 0);
  const serialized = JSON.stringify(r.trace);
  assert.ok(!serialized.includes(pwd), "raw password leaked into trace");
});

// ---------------------------------------------------------------------------
// E. "Я предпочитаю VS Code, мой API key sk-…" → secret removed, preference kept
// ---------------------------------------------------------------------------
test("E: secret redacted, preference survives", () => {
  const key = "sk-live-9Z8Y7X6W5V4U3T2S1";
  const r = runShadowPipeline(WRITE_DEFAULTS, {
    turnId: "t-e",
    text: `Я предпочитаю VS Code, мой API key ${key}`,
  });
  assert.ok(r.secrets.includes("api_key"));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].property, "preferred_editor");
  assert.equal(r.candidates[0].value, "VS Code");
  const serialized = JSON.stringify(r.trace);
  assert.ok(!serialized.includes(key), "API key leaked into trace");
  assert.ok(!serialized.includes("9Z8Y7X6W5V4U3T2S1"));
});

// ---------------------------------------------------------------------------
// F. большой технический log → SKIP NOISE
// ---------------------------------------------------------------------------
test("F: large technical log → SKIP NOISE", () => {
  const big = "x".repeat(1300);
  const r = runShadowPipeline(WRITE_DEFAULTS, {
    turnId: "t-f",
    text: big,
  });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].decision, "SKIP");
  assert.equal(r.decisions[0].reason, SKIP_REASONS.NOISE);
});

// ---------------------------------------------------------------------------
// G. неоднозначная информация → SKIP LOW_CONFIDENCE
// ---------------------------------------------------------------------------
test("G: hedged statement → SKIP LOW_CONFIDENCE", () => {
  const r = runShadowPipeline(WRITE_DEFAULTS, {
    turnId: "t-g",
    text: "наверное я предпочитаю VS Code",
  });
  assert.equal(r.candidates.length, 0);
  const d = r.decisions.find((x) => x.reason === SKIP_REASONS.LOW_CONFIDENCE);
  assert.ok(d, "expected a LOW_CONFIDENCE decision");
  assert.equal(d.decision, "SKIP");
});

// ---------------------------------------------------------------------------
// H. обычный вопрос пользователя без персонального факта → no candidates
// ---------------------------------------------------------------------------
test("H: plain question → no write candidates", () => {
  const r = runShadowPipeline(WRITE_DEFAULTS, {
    turnId: "t-h",
    text: "какой сейчас курс доллара?",
  });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.decisions.length, 0);
});

// ---------------------------------------------------------------------------
// Feature flags: enabled=false → never mutates (shadow only), trace produced
// ---------------------------------------------------------------------------
test("flags: enabled=false keeps write disabled, shadow still traces", () => {
  const r = runShadowPipeline({ ...WRITE_DEFAULTS, enabled: false, shadow: true }, {
    turnId: "t-flag",
    text: "Я предпочитаю VS Code",
  });
  assert.equal(r.writeEnabled, false);
  assert.equal(r.shadow, true);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.trace.length, 1);
});

test("flags: both disabled → fully inert", () => {
  const r = runShadowPipeline({ enabled: false, shadow: false }, {
    turnId: "t-inert",
    text: "Я предпочитаю VS Code",
  });
  assert.equal(r.inactive, true);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.trace.length, 0);
});

// ---------------------------------------------------------------------------
// secret-filter unit tests
// ---------------------------------------------------------------------------
test("scanSecrets: standalone sk- key redacted", () => {
  const { safeText, found, secrets } = scanSecrets("ключ sk-abc123xyz");
  assert.equal(found, true);
  assert.ok(secrets.some((s) => s.type === "api_key"));
  assert.ok(safeText.includes(REDACTED));
  assert.ok(!safeText.includes("sk-abc123xyz"));
});

test("scanSecrets: bearer token redacted", () => {
  const { safeText, found } = scanSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def");
  assert.equal(found, true);
  assert.ok(!safeText.includes("eyJhbGci"));
  assert.ok(safeText.includes(REDACTED));
});

test("scanSecrets: OTP digits redacted, keyword kept", () => {
  const { safeText, found } = scanSecrets("ваш код 482913");
  assert.equal(found, true);
  assert.ok(safeText.includes("код"));
  assert.ok(!safeText.includes("482913"));
  assert.ok(safeText.includes(REDACTED));
});

test("scanSecrets: private key block redacted", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
  const { safeText, found } = scanSecrets(pem);
  assert.equal(found, true);
  assert.ok(!safeText.includes("MIIEpAIBAAKCAQEA"));
});

test("scanSecrets: no secret → unchanged, found=false", () => {
  const { safeText, found } = scanSecrets("Я предпочитаю VS Code");
  assert.equal(found, false);
  assert.equal(safeText, "Я предпочитаю VS Code");
});

// ---------------------------------------------------------------------------
// extract unit tests
// ---------------------------------------------------------------------------
test("extractCandidates: no candidate for empty / question", () => {
  assert.equal(extractCandidates("").length, 0);
  assert.equal(extractCandidates("какой курс?").length, 0);
});

test("extractCandidates: multiple preferences", () => {
  const cs = extractCandidates("Я предпочитаю VS Code. Ещё люблю Python");
  assert.equal(cs.length, 2);
  assert.equal(cs[0].property, "preferred_editor");
  assert.equal(cs[0].value, "VS Code");
});

// ---------------------------------------------------------------------------
// gate unit tests
// ---------------------------------------------------------------------------
test("gateCandidate: unsupported type → SKIP UNSUPPORTED", () => {
  const r = gateCandidate({ type: "weird", value: "x", confidence: 0.9 });
  assert.equal(r.decision, "SKIP");
  assert.equal(r.reason, SKIP_REASONS.UNSUPPORTED);
});

test("gateCandidate: low confidence preference → SKIP LOW_CONFIDENCE", () => {
  const r = gateCandidate({ type: "preference", value: "x", confidence: 0.3 });
  assert.equal(r.decision, "SKIP");
  assert.equal(r.reason, SKIP_REASONS.LOW_CONFIDENCE);
});

test("classifyTurn: stack trace → noise", () => {
  const { isNoise } = classifyTurn("Traceback (most recent call last):\n  File \"x.py\", line 1\nValueError: boom");
  assert.equal(isNoise, true);
});

test("classifyTurn: smalltalk", () => {
  const { isSmalltalk } = classifyTurn("привет");
  assert.equal(isSmalltalk, true);
});
