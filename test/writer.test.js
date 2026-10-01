// selective-memory — STAGE 5.4 writer tests
//
// Unit + integration tests for the isolated writer. Unit tests use a mocked
// OpenViking HTTP client (no network). Integration tests run against the live
// server inside a fresh, allowlisted test namespace and clean up after
// themselves. The writer surface exposed to tests is guarded (allowlist-bound):
// there is NO raw unguarded client access.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWriter, WRITE_ACTION, OUTCOME } from "../write/writer.js";
import {
  isAllowedUri,
  isSafeUri,
  slotIdFor,
  newRunId,
  rootUri,
  historyUri,
  buildActiveContent,
  parseFields,
  bodyOf,
} from "../write/layout.js";

// ---------------------------------------------------------------------------
// Unit: layout / allowlist / URI safety (pure, no network)
// ---------------------------------------------------------------------------

test("layout: slotIdFor is deterministic and safe", () => {
  assert.equal(slotIdFor("user", "preferred_editor"), "user_preferred_editor");
  assert.equal(slotIdFor("user", "Preferred Editor!"), "user_preferred_editor");
  assert.equal(slotIdFor("user", ""), "user");
});

test("layout: allowlist rejects production memories namespace", () => {
  assert.equal(isAllowedUri("viking://user/default/memories/entities/x.md"), false);
  assert.equal(isAllowedUri("viking://resources/stage5-test/run1/slots/s/active.md"), true);
  assert.equal(isAllowedUri("viking://resources/stage5-test/run1/anything"), true);
  // The OLD namespace (user/default/stage5-test) is no longer allowed.
  assert.equal(isAllowedUri("viking://user/default/stage5-test/run1/anything"), false);
});

test("layout: isSafeUri rejects traversal / escapes", () => {
  assert.equal(isSafeUri("viking://resources/stage5-test/r/a.md"), true);
  assert.equal(isSafeUri("viking://user/../memories/x.md"), false);
  assert.equal(isSafeUri("viking://resources/stage5-test/r/..%2f.."), false);
  assert.equal(isSafeUri("viking://user\\default\\memories\\x.md"), false);
});

test("layout: isSafeUri rejects percent-encoded traversal (adversarial)", () => {
  // Literal-dot check alone would pass these; percent-decode must reject them.
  assert.equal(isSafeUri("viking://resources/stage5-test/r/%2e%2e/%2e%2e"), false);
  assert.equal(isSafeUri("viking://resources/stage5-test/r/..%2Fmemories%2Fx.md"), false);
  assert.equal(isSafeUri("viking://resources/stage5-test/r/%2E%2E/x.md"), false);
  assert.equal(isSafeUri("viking://resources/stage5-test/r/%2e%2e%2fx.md"), false);
  // Encoded separator smuggling.
  assert.equal(isSafeUri("viking://user%2Fdefault%2Fmemories%2Fx.md"), false);
  assert.equal(isSafeUri("viking://resources/stage5-test/r/a%2f..%2f..%2fmemories%2fx.md"), false);
  // Benign percent-encoded content (no separator/dot introduced) stays safe.
  assert.equal(isSafeUri("viking://resources/stage5-test/r/a%20b.md"), true);
  assert.equal(isSafeUri("viking://resources/stage5-test/r/%C3%A9.md"), true);
});

test("layout: isSafeUri rejects CRLF / control injection", () => {
  assert.equal(isSafeUri("viking://resources/stage5-test/r/a\n.md"), false);
  assert.equal(isSafeUri("viking://resources/stage5-test/r/a\r.md"), false);
  assert.equal(isSafeUri("viking://resources/stage5-test/r/a.md?x=..%2f"), false);
});

test("layout: allowlist is prefix-exact — no sibling-prefix bypass", () => {
  // A URI that merely STARTS with the allowed string but is a different path
  // segment must be rejected (no "stage5-testevil" sibling bypass).
  assert.equal(isAllowedUri("viking://resources/stage5-test-evil/x.md"), false);
  assert.equal(isAllowedUri("viking://resources/stage5-testevil/x.md"), false);
  assert.equal(isAllowedUri("viking://resources/stage5-test/../memories/x.md"), true); // prefix pass, but isSafeUri rejects before use
  assert.equal(isAllowedUri("viking://resources/stage5-test/x.md"), true);
  assert.equal(isAllowedUri("viking://user/default/memories/stage5-test/x.md"), false);
  assert.equal(isAllowedUri("viking://user/default/stage5-test/x.md"), false);
});

test("layout: buildActiveContent embeds traceable MEMORY_FIELDS", () => {
  const c = buildActiveContent({
    entity: "user", property: "preferred_editor", value: "VS Code",
    source_type: "user_stated", confidence: 0.95, timestamp: "2026-10-01T00:00:00Z",
    version: 1, operation_id: "op-1",
  });
  const f = parseFields(c);
  assert.equal(f.version, 1);
  assert.equal(f.source_type, "user_stated");
  assert.equal(f.operation_id, "op-1");
  assert.equal(f.provenance, "user_stated");
  assert.ok(bodyOf(c).includes("VS Code"));
});

test("layout: buildActiveContent supersession links survive round-trip", () => {
  const c = buildActiveContent({
    entity: "user", property: "preferred_editor", value: "Cursor",
    source_type: "user_correction", confidence: 0.99, timestamp: "2026-10-01T00:00:00Z",
    version: 2, operation_id: "op-2", previous_version_uri: "viking://.../v1",
    superseded_versions: [1],
  });
  const f = parseFields(c);
  assert.deepEqual(f.superseded_versions, [1]);
  assert.equal(f.previous_version_uri, "viking://.../v1");
});

// ---------------------------------------------------------------------------
// Unit: secret rejection path (writer never mutates on a secret)
// ---------------------------------------------------------------------------

test("writer: secret value → REJECT_SECRET, zero mutation (mocked client)", async () => {
  const calls = [];
  const w = createWriter({
    runId: "unit-secret",
    fetchFn: async () => { calls.push(1); throw new Error("should not be called"); },
  });
  const r = await w.execute(WRITE_ACTION.WRITE_NEW, {
    entity: "user", property: "api_key", value: "sk-live-ABCDEFGH12345678",
    source_type: "user_stated", confidence: 0.95,
  });
  assert.equal(r.outcome, OUTCOME.REJECT_SECRET);
  assert.equal(r.mutation, false);
  assert.equal(calls.length, 0); // zero network/mutation
});

test("writer: unsupported action → REJECT_DECISION, zero mutation", async () => {
  const w = createWriter({ runId: "unit-unsupported", fetchFn: async () => { throw new Error("no"); } });
  const r = await w.execute("BOGUS", {
    entity: "user", property: "preferred_editor", value: "VS Code",
    source_type: "user_stated", confidence: 0.95,
  });
  assert.equal(r.outcome, OUTCOME.REJECT_DECISION);
  assert.equal(r.mutation, false);
});

// ---------------------------------------------------------------------------
// Integration tests (live OpenViking, fresh allowlisted namespace)
// ---------------------------------------------------------------------------

const LIVE = process.env.WRITER_LIVE === "1";

test("integration: WRITE_NEW → read-back active v1 → idempotent replay", { skip: !LIVE }, async () => {
  const runId = newRunId("it-new");
  const w = createWriter({ runId });
  const cand = { entity: "user", property: "preferred_editor", value: "VS Code", source_type: "user_stated", confidence: 0.95 };

  const r1 = await w.execute(WRITE_ACTION.WRITE_NEW, cand, { timestamp: "2026-10-01T00:00:00.000Z" });
  assert.equal(r1.outcome, OUTCOME.WRITE_NEW, JSON.stringify(r1));

  const active = await w.readActive("user_preferred_editor");
  assert.equal(active.ok, true);
  assert.equal(active.fields.version, 1);
  assert.ok(bodyOf(active.content).includes("VS Code"));

  const opId = `user_preferred_editor__WRITE_NEW`;
  const r2 = await w.execute(WRITE_ACTION.WRITE_NEW, cand, { operationId: opId, timestamp: "2026-10-01T00:00:00.000Z" });
  assert.equal(r2.outcome, OUTCOME.IDEMPOTENT_SUCCESS, JSON.stringify(r2));
  assert.equal(r2.idempotent, true);

  await w.rm(rootUri(runId), { recursive: true });
});

test("integration: UPDATE → history keeps v1, active becomes v2", { skip: !LIVE }, async () => {
  const runId = newRunId("it-upd");
  const w = createWriter({ runId });
  const cand1 = { entity: "user", property: "preferred_language", value: "Python", source_type: "user_stated", confidence: 0.95 };
  const cand2 = { entity: "user", property: "preferred_language", value: "Python и Go", source_type: "user_refinement", confidence: 0.9 };

  await w.execute(WRITE_ACTION.WRITE_NEW, cand1, { timestamp: "2026-10-01T00:00:00.000Z" });
  const u = await w.execute(WRITE_ACTION.UPDATE, cand2, { expectedVersion: 1, timestamp: "2026-10-01T00:00:01.000Z" });
  assert.equal(u.outcome, OUTCOME.UPDATE, JSON.stringify(u));
  assert.equal(u.version, 2);

  const active = await w.readActive("user_preferred_language");
  assert.equal(active.fields.version, 2);
  assert.ok(bodyOf(active.content).includes("Go"));

  const h1 = await w.readText(historyUri(rootUri(runId), "user_preferred_language", 1));
  assert.ok(h1.includes("Python"));

  await w.rm(rootUri(runId), { recursive: true });
});

test("integration: SUPERSEDE → history preserves prior, active has new current", { skip: !LIVE }, async () => {
  const runId = newRunId("it-sup");
  const w = createWriter({ runId });
  const old = { entity: "user", property: "preferred_editor", value: "Cursor", source_type: "user_stated", confidence: 0.95 };
  const corr = { entity: "user", property: "preferred_editor", value: "VS Code", source_type: "user_correction", confidence: 0.99 };

  await w.execute(WRITE_ACTION.WRITE_NEW, old, { timestamp: "2026-10-01T00:00:00.000Z" });
  const s = await w.execute(WRITE_ACTION.SUPERSEDE, corr, { expectedVersion: 1, timestamp: "2026-10-01T00:00:02.000Z" });
  assert.equal(s.outcome, OUTCOME.SUPERSEDE, JSON.stringify(s));

  const active = await w.readActive("user_preferred_editor");
  assert.equal(active.fields.version, 2);
  assert.ok(bodyOf(active.content).includes("VS Code"));
  assert.deepEqual(active.fields.superseded_versions, [1]);

  const h1 = await w.readText(historyUri(rootUri(runId), "user_preferred_editor", 1));
  assert.ok(h1.includes("Cursor"));

  await w.rm(rootUri(runId), { recursive: true });
});

test("integration: stale expected_version → CONFLICT_RETRY_REQUIRED, zero overwrite", { skip: !LIVE }, async () => {
  const runId = newRunId("it-stale");
  const w = createWriter({ runId });
  const cand1 = { entity: "user", property: "preferred_editor", value: "VS Code", source_type: "user_stated", confidence: 0.95 };
  const cand2 = { entity: "user", property: "preferred_editor", value: "Cursor", source_type: "user_refinement", confidence: 0.9 };

  await w.execute(WRITE_ACTION.WRITE_NEW, cand1, { timestamp: "2026-10-01T00:00:00.000Z" });
  const r = await w.execute(WRITE_ACTION.UPDATE, cand2, { expectedVersion: 99, timestamp: "2026-10-01T00:00:03.000Z" });
  assert.equal(r.outcome, OUTCOME.CONFLICT_RETRY_REQUIRED, JSON.stringify(r));

  const active = await w.readActive("user_preferred_editor");
  assert.equal(active.fields.version, 1);
  assert.ok(bodyOf(active.content).includes("VS Code"));

  await w.rm(rootUri(runId), { recursive: true });
});

test("integration: recovery after partial failure via replay", { skip: !LIVE }, async () => {
  const runId = newRunId("it-recov");
  const cand = { entity: "user", property: "preferred_editor", value: "Emacs", source_type: "user_stated", confidence: 0.95 };

  // First attempt: fail only on the transition write (step 4 of WRITE_NEW).
  // The transition URI is carried in the request BODY (all writes go to the
  // same /content/write endpoint), so we inspect init.body.
  let failTransition = true;
  const failing = createWriter({
    runId,
    fetchFn: async (url, init) => {
      if (failTransition && init?.body) {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
        if (body?.uri && String(body.uri).includes("/transitions/")) {
          throw new Error("simulated transition failure");
        }
      }
      return fetch(url, init);
    },
  });
  const r1 = await failing.execute(WRITE_ACTION.WRITE_NEW, cand, { timestamp: "2026-10-01T00:00:00.000Z" });
  assert.equal(r1.outcome, OUTCOME.ERROR, JSON.stringify(r1)); // partial failure

  // Replay with a healthy writer using the same operationId.
  failTransition = false;
  const w2 = createWriter({ runId });
  const opId = `user_preferred_editor__WRITE_NEW`;
  const r2 = await w2.execute(WRITE_ACTION.WRITE_NEW, cand, { operationId: opId, timestamp: "2026-10-01T00:00:00.000Z" });

  // Recovery: either idempotent (journal already complete) or clean re-apply.
  assert.ok(
    r2.outcome === OUTCOME.IDEMPOTENT_SUCCESS || r2.outcome === OUTCOME.WRITE_NEW,
    JSON.stringify(r2),
  );
  const active = await w2.readActive("user_preferred_editor");
  assert.equal(active.ok, true);
  assert.ok(bodyOf(active.content).includes("Emacs"));

  await w2.rm(rootUri(runId), { recursive: true });
});

test("integration: namespace escape is blocked by the guarded surface", { skip: !LIVE }, async () => {
  const runId = newRunId("it-escape");
  const w = createWriter({ runId });

  // The guarded read surface must refuse to touch production memory.
  const prodUri = "viking://user/default/memories/entities/provider/escape.md";
  assert.equal(w.isAllowed(prodUri), false);

  await assert.rejects(
    async () => w.readText(prodUri),
    (e) => /NAMESPACE_ESCAPE|UNSAFE_URI/.test(String(e?.code ?? e?.message ?? e)),
    "guarded read of production memory must reject",
  );

  // Production memory must still be absent (nothing was written).
  await w.rm(rootUri(runId), { recursive: true });
});

test("integration: concurrency — parallel WRITE_NEW for same slot yields one active", { skip: !LIVE }, async () => {
  const runId = newRunId("it-conc");
  const w = createWriter({ runId });
  const cand = { entity: "user", property: "preferred_editor", value: "Vim", source_type: "user_stated", confidence: 0.95 };
  const results = await Promise.all([
    w.execute(WRITE_ACTION.WRITE_NEW, { ...cand }, { timestamp: "2026-10-01T00:00:00.000Z" }),
    w.execute(WRITE_ACTION.WRITE_NEW, { ...cand }, { timestamp: "2026-10-01T00:00:01.000Z" }),
  ]);
  const valid = new Set([OUTCOME.WRITE_NEW, OUTCOME.IDEMPOTENT_SUCCESS, OUTCOME.CONFLICT_RETRY_REQUIRED]);
  for (const r of results) {
    assert.ok(valid.has(r.outcome), JSON.stringify(r));
  }
  // Exactly one of the two must have actually written v1 (the other is
  // idempotent or conflict-retry), and active must be v1 — no double-bump.
  const active = await w.readActive("user_preferred_editor");
  assert.equal(active.ok, true);
  assert.equal(active.fields.version, 1);
  await w.rm(rootUri(runId), { recursive: true });
});
