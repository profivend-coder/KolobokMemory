// STAGE 5.3 controlled shadow smoke (NO mutation).
// Exercises all 7 decision actions via injected fixture lookups, then prints
// the decision distribution. No OpenViking endpoint is called; every lookup
// is a deterministic fixture. Secret values are asserted absent from trace.
import { runDecisionPipeline, WRITE_DEFAULTS } from "../write/index.js";
import { DECISION, resolveDecision } from "../write/conflict.js";
import { classifyDedup } from "../write/dedup.js";

function mem({ uri, property, value, source_type = null, score = 0.8 }) {
  const m = { uri, score };
  if (property) m.property = property;
  if (value) m.value = value;
  if (source_type) m.source_type = source_type;
  return m;
}

// Each fixture: turn text + a lookup returning { byValue, byProperty }.
const fixtures = [
  {
    id: "F1-NOT_FOUND",
    text: "Я предпочитаю VS Code",
    lookup: async () => ({
      byValue: { ok: true, error: null, memories: [] },
      byProperty: { ok: true, error: null, memories: [] },
    }),
    expect: DECISION.WOULD_WRITE_NEW,
  },
  {
    id: "F2-SAME",
    text: "Я предпочитаю VS Code",
    lookup: async () => ({
      byValue: { ok: true, error: null, memories: [mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "VS Code" })] },
      byProperty: { ok: true, error: null, memories: [] },
    }),
    expect: DECISION.SKIP_DUPLICATE,
  },
  {
    id: "F3-AMBIGUOUS",
    text: "Я предпочитаю VS Code",
    lookup: async () => ({
      byValue: { ok: false, error: "timeout", memories: [] },
      byProperty: { ok: true, error: null, memories: [] },
    }),
    expect: DECISION.SKIP_AMBIGUOUS,
  },
  {
    id: "F4-CONFLICT",
    text: "Я предпочитаю VS Code", // user_stated contradicts user_stated
    lookup: async () => ({
      byValue: { ok: true, error: null, memories: [] },
      byProperty: { ok: true, error: null, memories: [mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "Cursor", source_type: "user_stated" })] },
    }),
    expect: DECISION.SKIP_CONFLICT,
  },
  {
    id: "F5-LOW_TRUST",
    // hedged → Write Gate SKIP(LOW_CONFIDENCE), never reaches the engine;
    // exercised directly below instead.
    text: "наверное я предпочитаю VS Code",
    lookup: async () => ({
      byValue: { ok: true, error: null, memories: [] },
      byProperty: { ok: true, error: null, memories: [mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "Cursor", source_type: "user_stated" })] },
    }),
    expect: null, // no KEEP candidate
    note: "hedged → Write Gate LOW_CONFIDENCE (pre-engine)",
  },
  {
    id: "F6-SUPERSEDE",
    text: "теперь VS Code, а раньше был Cursor",
    lookup: async () => ({
      byValue: { ok: true, error: null, memories: [] },
      byProperty: { ok: true, error: null, memories: [mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "Cursor", source_type: "user_stated" })] },
    }),
    expect: DECISION.WOULD_SUPERSEDE,
  },
  {
    id: "F7-UPDATE",
    text: "а ещё люблю Python", // refinement
    lookup: async () => ({
      byValue: { ok: true, error: null, memories: [] },
      byProperty: { ok: true, error: null, memories: [mem({ uri: "viking://mem/lang.md", property: "preferred_language", value: "Go", source_type: "user_stated" })] },
    }),
    expect: DECISION.WOULD_UPDATE,
  },
];

const counts = Object.fromEntries(Object.values(DECISION).map((d) => [d, 0]));
let mismatches = 0;

for (const fx of fixtures) {
  const r = await runDecisionPipeline(WRITE_DEFAULTS, { turnId: `smoke-${fx.id}`, text: fx.text }, fx.lookup);
  const keeps = r.trace.filter((t) => t.decision === "KEEP");
  if (keeps.length === 0) {
    console.log(`${fx.id}: no KEEP candidate (${r.decisions.map((d) => `${d.decision}${d.reason ? "(" + d.reason + ")" : ""}`).join(", ") || "none"})${fx.note ? " — " + fx.note : ""}`);
    continue;
  }
  for (const k of keeps) {
    const wd = k.write_decision ?? {};
    const action = wd.action ?? "?";
    counts[action] = (counts[action] ?? 0) + 1;
    const ok = action === fx.expect ? "" : "  ⚠️ MISMATCH";
    if (action !== fx.expect) mismatches++;
    console.log(`${fx.id}: ${k.candidate.property}=${k.candidate.value} [src=${k.candidate.source_type}] → ${action} (${wd.reason})${ok}`);
  }
}

// SKIP_LOW_TRUST cannot arise from user text (extraction only yields
// user_stated/correction/refinement), so it is exercised directly: a lower-trust
// candidate (agent_inferred) colliding with a user_stated memory.
{
  const cand = { entity: "user", property: "preferred_editor", value: "VS Code", source_type: "agent_inferred" };
  const dedup = classifyDedup(cand, {
    byValue: { ok: true, error: null, memories: [] },
    byProperty: { ok: true, error: null, memories: [mem({ uri: "viking://mem/e.md", property: "preferred_editor", value: "Cursor", source_type: "user_stated" })] },
  });
  const d = resolveDecision(cand, dedup);
  counts[d.action] = (counts[d.action] ?? 0) + 1;
  const ok = d.action === DECISION.SKIP_LOW_TRUST ? "" : "  ⚠️ MISMATCH";
  if (d.action !== DECISION.SKIP_LOW_TRUST) mismatches++;
  console.log(`F8-LOW_TRUST(direct): agent_inferred vs user_stated → ${d.action} (${d.reason})${ok}`);
}

console.log("\n=== decision distribution ===");
for (const d of Object.values(DECISION)) console.log(`${d}: ${counts[d] ?? 0}`);
console.log(`mismatches: ${mismatches}`);
console.log("shadow smoke complete — no mutation issued.");
