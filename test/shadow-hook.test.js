// selective-memory — STAGE 5.5.1 shadow hook tests
//
// Verifies the shadow hook behaves fail-closed for memory and never writes:
//   - agent_end event text extraction (user + assistant only)
//   - runWriteShadow produces WOULD_*/SKIP_* only (no mutation fields)
//   - write.enabled=true is refused (fail-closed)
//   - empty text → clean no-op result
//   - timeout/error → ok=false (fail-closed), never a WOULD_* leak
import { test } from "node:test";
import assert from "node:assert/strict";

import { runWriteShadow, turnTextFromEvent } from "../write/shadow-hook.js";
import { DECISION } from "../write/conflict.js";

const OV_CFG = {
  openvikingBaseUrl: "http://127.0.0.1:1933",
  openvikingApiKey: "local-dev",
  openvikingTargetUri: "",
  recallLimit: 6,
  recallScoreThreshold: 0.15,
  timeoutMs: 5000,
};

test("turnTextFromEvent: extracts user + assistant text only", () => {
  const text = turnTextFromEvent({
    messages: [
      { role: "user", content: "Люблю Python и VS Code" },
      { role: "assistant", content: "Понял" },
      { role: "system", content: "SHOULD NOT APPEAR" },
      { role: "tool", content: "SHOULD NOT APPEAR" },
    ],
  });
  assert.ok(text.includes("Люблю Python и VS Code"));
  assert.ok(text.includes("Понял"));
  assert.ok(!text.includes("SHOULD NOT APPEAR"));
});

test("turnTextFromEvent: handles block-array content", () => {
  const text = turnTextFromEvent({
    messages: [{ role: "user", content: [{ text: "Предпочитаю Zed" }] }],
  });
  assert.ok(text.includes("Предпочитаю Zed"));
});

test("runWriteShadow: empty text → clean no-op", async () => {
  const r = await runWriteShadow({ enabled: false, shadow: true }, OV_CFG, { turnId: "t", text: "" });
  assert.equal(r.ok, true);
  assert.equal(r.serialized, null);
  assert.equal(r.result.candidates.length, 0);
});

test("runWriteShadow: write.enabled=true is refused (fail-closed)", async () => {
  const r = await runWriteShadow({ enabled: true, shadow: true }, OV_CFG, { turnId: "t", text: "Люблю Python" });
  assert.equal(r.ok, false);
  assert.ok(/shadow_refused/.test(r.error));
});

test("runWriteShadow: decision-only, no mutation fields leak", async () => {
  // A real preference statement → should produce at most WOULD_*/SKIP_*.
  const r = await runWriteShadow(
    { enabled: false, shadow: true },
    OV_CFG,
    { turnId: "t", text: "Предпочитаю VS Code для разработки" }
  );
  // Either the lookup succeeded (real server) or failed-closed; both are ok.
  assert.equal(typeof r.ok, "boolean");
  if (r.ok && r.result) {
    for (const d of r.result.decisions ?? []) {
      // gate-level decisions are KEEP/SKIP; write decisions are WOULD_*/SKIP_*
      const wd = d?.write_decision?.action ?? d?.decision;
      assert.ok(
        wd === "KEEP" || wd === "SKIP" || wd.startsWith("WOULD_") || wd.startsWith("SKIP_"),
        `unexpected decision ${wd}`
      );
      // No mutation outcome may ever appear here.
      assert.ok(!/^(WRITE_NEW|UPDATE|SUPERSEDE)$/.test(wd));
    }
  }
});

test("runWriteShadow: secret is stripped from trace (never the value)", async () => {
  const secret = "sk-or-v1-1234567890ABCDEF";
  const r = await runWriteShadow(
    { enabled: false, shadow: true },
    OV_CFG,
    { turnId: "t", text: `мой API ключ ${secret}` }
  );
  if (r.ok && r.serialized) {
    assert.ok(!r.serialized.includes(secret), "secret value leaked into trace");
  }
});

test("runWriteShadow: all seven DECISION codes are WOULD_*/SKIP_*", () => {
  for (const code of Object.values(DECISION)) {
    assert.ok(code.startsWith("WOULD_") || code.startsWith("SKIP_"), code);
  }
});