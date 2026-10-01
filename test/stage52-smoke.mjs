// STAGE 5.2 controlled READ-ONLY smoke: run the dedup lookup against the real
// OpenViking (search/find only — no write endpoint is touched), and print the
// classification. Never mutates memory.
import { runDedupPipeline, WRITE_DEFAULTS } from "../write/index.js";
import { createLookup } from "../write/lookup.js";

const ovCfg = {
  openvikingBaseUrl: "http://127.0.0.1:1933",
  openvikingApiKey: "local-dev",
  openvikingTargetUri: "",
  recallLimit: 6,
  recallScoreThreshold: 0.15,
  timeoutMs: 5000,
};

const lookup = createLookup(ovCfg);

const cases = [
  ["S1", "Я предпочитаю VS Code"],
  ["S2", "Я предпочитаю Python"],
];

for (const [id, text] of cases) {
  const r = await runDedupPipeline(WRITE_DEFAULTS, { turnId: `smoke-${id}`, text }, lookup);
  for (const t of r.trace) {
    if (t.decision !== "KEEP") continue;
    const d = t.dedup ?? {};
    console.log(`${id}: ${t.candidate.property}=${t.candidate.value} → ${d.status} (${d.reason}) [evidence=${(d.evidence || []).length}]`);
  }
  if (!r.candidates.length) {
    const skips = r.decisions.map((x) => `${x.decision}${x.reason ? "(" + x.reason + ")" : ""}`).join(", ") || "none";
    console.log(`${id}: no KEEP candidates (decisions: ${skips})`);
  }
}
console.log("READ-ONLY smoke complete — no write issued.");
