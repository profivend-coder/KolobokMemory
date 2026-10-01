// STAGE 4.2 ITERATION 2 controlled smoke — adaptive query A/B/C/D
// against the LIVE OpenViking API. Read-only: no writes, no Jev, no injection.
import { buildAdaptiveQuery, openvikingFind } from "../index.js";

const CFG = {
  recallLimit: 6,
  recallScoreThreshold: 0.15,
  openvikingBaseUrl: "http://127.0.0.1:1933",
  openvikingApiKey: "local-dev",
  openvikingTargetUri: "",
  timeoutMs: 5000,
};

function fmt(mems) {
  return mems.slice(0, 6).map((m) => ({
    score: Number((m.score ?? 0).toFixed(3)),
    uri: String(m.uri || "").split("/").filter(Boolean).slice(-2).join("/"),
    abstract: String(m.abstract || "").slice(0, 60),
  }));
}

const SELECTIVE = /selective|memory|STAGE 4\.1|jev|recall/i;
const NGINX = /nginx|server|proxy|ssl|443|порт/i;

async function run(label, event, expectMode, expectMatch, forbidMatch) {
  const a = buildAdaptiveQuery(event);
  const res = await openvikingFind(CFG, a.query);
  const top = fmt(res);
  const hit = top.some((r) => expectMatch.test(`${r.uri} ${r.abstract}`));
  const contamination = forbidMatch ? top.some((r) => forbidMatch.test(`${r.uri} ${r.abstract}`)) : false;
  const modeOk = a.queryMode === expectMode;
  const pass = modeOk && hit && !contamination;

  console.log(`\n===== ${label} =====`);
  console.log(`prompt:      ${JSON.stringify(event.prompt)}`);
  console.log(`queryMode:   ${a.queryMode} (expect ${expectMode}) ${modeOk ? "OK" : "FAIL"}`);
  console.log(`queryReason: ${a.queryReason}`);
  console.log(`queryMessages=${a.queryMessages} queryChars=${a.queryChars} promptDedup=${a.promptDedup}`);
  console.log(`query:       ${JSON.stringify(a.query)}`);
  console.log(`top-6:`);
  top.forEach((r) => console.log(`  ${r.score}  ${r.uri}  ${r.abstract}`));
  console.log(`relevant-hit=${hit} contamination=${contamination} => ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

const selMsg = [
  { role: "user", content: "Мы закончили STAGE 4.1 selective-memory quality fix" },
  { role: "user", content: "Начинай STAGE 4.2 contextual retrieval query" },
];
const ngxMsg = [
  { role: "user", content: "Настраиваем nginx reverse proxy на 443 с SSL" },
  { role: "user", content: "Проверь конфиг nginx и сертификаты" },
];

const results = [];
results.push(await run("A: explicit topic (current)",
  { prompt: "Что мы сделали в STAGE 4.1?", messages: selMsg },
  "current", SELECTIVE, null));

results.push(await run("B: contextual short (history)",
  { prompt: "Сделано?", messages: selMsg },
  "contextual", SELECTIVE, null));

results.push(await run("C: new standalone topic (no contamination)",
  { prompt: "nginx reverse proxy 443", messages: selMsg },
  "current", NGINX, SELECTIVE));

results.push(await run("D: contextual short after nginx (nginx results)",
  { prompt: "Почему?", messages: ngxMsg },
  "contextual", NGINX, SELECTIVE));

const ok = results.every(Boolean);
console.log(`\n===== RESULT: ${ok ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/4) =====`);
process.exit(ok ? 0 : 1);
