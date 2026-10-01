// STAGE 5.1 demo: run the shadow pipeline over the requirement cases A–H and
// persist a JSONL trace. Used to (a) show KEEP/SKIP behaviour and (b) prove no
// secret leaks into the persisted trace.
import { writeFileSync, mkdirSync } from "node:fs";
import { runShadowPipeline, WRITE_DEFAULTS } from "../write/index.js";

const CASES = [
  ["A", "Я предпочитаю VS Code"],
  ["B", "Сегодня дождь"],
  ["C", "вот мой ключ sk-abcdef1234567890ABCDEF"],
  ["D", "пароль: hunter2secret"],
  ["E", "Я предпочитаю VS Code, мой API key sk-live-9Z8Y7X6W5V4U3T2S1"],
  ["F", "Traceback (most recent call last):\n  File \"app.py\", line 3, in <module>\nValueError: boom".padEnd(1300, "x")],
  ["G", "наверное я предпочитаю VS Code"],
  ["H", "какой сейчас курс доллара?"],
];

const rows = [];
for (const [id, text] of CASES) {
  const r = runShadowPipeline(WRITE_DEFAULTS, { turnId: `demo-${id}`, text });
  for (const e of r.trace) rows.push(JSON.stringify(e));
}

const outDir = "/root/audit-43/stage51";
mkdirSync(outDir, { recursive: true });
const outFile = outDir + "/shadow-trace.jsonl";
writeFileSync(outFile, rows.join("\n") + (rows.length ? "\n" : ""));
console.log(`wrote ${rows.length} trace lines to ${outFile}`);

// Also print human-readable decisions for the report.
for (const [id, text] of CASES) {
  const r = runShadowPipeline(WRITE_DEFAULTS, { turnId: `demo-${id}`, text });
  const dec = r.decisions.map((d) => `${d.decision}${d.reason ? "(" + d.reason + ")" : ""}`).join(", ") || "—";
  console.log(`${id}: ${dec}`);
}
