import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractSummaryFromRaw,
  abstractFallback,
  capItem,
  boundedJoin,
  enrichSummaries,
  buildInjectedContext,
  buildEndLogLine,
  buildContextualQuery,
  buildAdaptiveQuery,
  classifyPromptContext,
  messageText,
  isSyntheticUserText,
  openvikingFind,
} from "../index.js";

// Response shim: fetchJson expects a Response-like {ok, json()}; production `fetch`
// returns that naturally, mocks return plain objects here.
const resp = (obj) => ({ ok: true, json: async () => obj });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const DEFAULT_CFG = {
  recallLimit: 6,
  recallScoreThreshold: 0.15,
  openvikingBaseUrl: "http://127.0.0.1:1933",
  openvikingApiKey: "local-dev",
  openvikingTargetUri: "",
  timeoutMs: 5000,
  summaryConcurrency: 3,
  summaryFallbackChars: 250,
  maxInjectedCharsL0: 400,
  maxInjectedCharsL1: 1000,
  maxInjectedCharsL2: 3000,
  l1PerItemCap: 300,
  l2PerItemCap: 900,
  l1MaxItems: 3,
  l2MaxItems: 3,
  jevModel: "typesafe/jev-1.13",
};

function rawWithSummary(summary) {
  return (
    "# Summary\nsome body text\n# ChatLog\n**user**: hello\n\n" +
    "<!-- MEMORY_FIELDS\n" +
    JSON.stringify({ summary, version: 1 }, null, 2) +
    "\n-->"
  );
}

function makeMem(i, { abstract, uri, score } = {}) {
  return {
    uri: uri ?? `viking://user/default/memories/events/m${i}.md`,
    score: score ?? 0.3 + i * 0.01,
    abstract: abstract ?? `detail body for memory ${i}`,
    level: 2,
    context_type: "memory",
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// 1. MEMORY_FIELDS.summary parses correctly
// ---------------------------------------------------------------------------
test("extractSummaryFromRaw: parses native summary", () => {
  const raw = rawWithSummary("On 2026-09-28 OpenClaw fixed the telegram_username bug");
  assert.equal(
    extractSummaryFromRaw(raw),
    "On 2026-09-28 OpenClaw fixed the telegram_username bug",
  );
});

// ---------------------------------------------------------------------------
// 2. malformed MEMORY_FIELDS → null (fallback)
// ---------------------------------------------------------------------------
test("extractSummaryFromRaw: malformed MEMORY_FIELDS returns null", () => {
  assert.equal(extractSummaryFromRaw("<!-- MEMORY_FIELDS\n{not json}\n-->"), null);
  assert.equal(extractSummaryFromRaw("no fields block at all"), null);
  assert.equal(extractSummaryFromRaw(""), null);
  assert.equal(extractSummaryFromRaw(null), null);
  // valid JSON but no summary key
  assert.equal(
    extractSummaryFromRaw("<!-- MEMORY_FIELDS\n" + JSON.stringify({ version: 1 }) + "\n-->"),
    null,
  );
});

test("openvikingFind: excludes OpenViking sidecar files", async () => {
  const cfg = { ...DEFAULT_CFG };
  const fetchFn = async () =>
    resp({
      result: {
        memories: [
          makeMem(0, { uri: "viking://user/default/memories/events/real.md" }),
          makeMem(1, { uri: "viking://user/default/memories/events/.overview.md" }),
          makeMem(2, { uri: "viking://user/default/memories/events/.abstract.md" }),
        ],
      },
    });

  const out = await openvikingFind(cfg, "selective memory", fetchFn);
  assert.deepEqual(
    out.map((m) => m.uri),
    ["viking://user/default/memories/events/real.md"],
  );
});

// ---------------------------------------------------------------------------
// 3. raw request timeout/error → fallback
// ---------------------------------------------------------------------------
test("enrichSummaries: raw fetch error falls back to abstract", async () => {
  const failingFetch = async (url) => {
    if (String(url).includes("search/find")) throw new Error("unused");
    throw new Error("network down");
  };
  const mems = [makeMem(0, { abstract: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" })];
  const out = await enrichSummaries(DEFAULT_CFG, mems, failingFetch);
  assert.equal(out.length, 1);
  assert.equal(out[0].summaryFallback, true);
  assert.equal(out[0].summary, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".slice(0, 250));
});

test("enrichSummaries: missing summary key falls back to abstract", async () => {
  const fetchFn = async (url) => {
    if (String(url).includes("search/find")) throw new Error("unused");
    return resp({ result: "# Summary\nno fields here" });
  };
  const mems = [makeMem(0, { abstract: "fallback-text-12345" })];
  const out = await enrichSummaries(DEFAULT_CFG, mems, fetchFn);
  assert.equal(out[0].summary, "fallback-text-12345");
  assert.equal(out[0].summaryFallback, true);
});

test("enrichSummaries: native summary wins over abstract", async () => {
  const fetchFn = async (url) => {
    if (String(url).includes("search/find")) throw new Error("unused");
    return resp({ result: rawWithSummary("NATIVE SUMMARY") });
  };
  const mems = [makeMem(0, { abstract: "LONG ABSTRACT THAT IS NOT THE SUMMARY" })];
  const out = await enrichSummaries(DEFAULT_CFG, mems, fetchFn);
  assert.equal(out[0].summary, "NATIVE SUMMARY");
  assert.equal(out[0].summaryFallback, false);
});

// ---------------------------------------------------------------------------
// 4. L1 contains 3 summaries when 3 candidates
// 7. L1 total <= 1000 chars
// ---------------------------------------------------------------------------
test("buildInjectedContext L1: up to 3 summaries, total <= 1000", () => {
  const mems = [
    makeMem(0, { abstract: "x" }),
    makeMem(1, { abstract: "x" }),
    makeMem(2, { abstract: "x" }),
    makeMem(3, { abstract: "x" }),
  ];
  // attach short summaries manually (simulating enriched output)
  const enriched = mems.map((m, i) => ({ ...m, summary: `summary-${i}-` + "a".repeat(20) }));
  const { text, count, chars } = buildInjectedContext(DEFAULT_CFG, "L1", enriched);
  assert.equal(count, 3); // only top-3, 4th dropped
  assert.ok(chars <= 1000, `L1 chars ${chars} exceeds 1000`);
  assert.ok(text.includes("summary-0"));
  assert.ok(text.includes("summary-2"));
  assert.ok(!text.includes("summary-3"));
});

// ---------------------------------------------------------------------------
// 5. L2 contains up to 3 items
// 6. one DETAIL > 3000 does not eat the whole budget
// 8. L2 total <= 3000
// ---------------------------------------------------------------------------
test("buildInjectedContext L2: up to 3 items, one huge detail does not exceed 3000", () => {
  const huge = "Z".repeat(5000);
  const mems = [
    makeMem(0, { abstract: huge }),
    makeMem(1, { abstract: "short-1" }),
    makeMem(2, { abstract: "short-2" }),
    makeMem(3, { abstract: "short-3" }),
  ];
  const { text, count, chars } = buildInjectedContext(DEFAULT_CFG, "L2", mems);
  assert.equal(count, 3); // still 3 items (first truncated to 900, others fit)
  assert.ok(chars <= 3000, `L2 chars ${chars} exceeds 3000`);
  // the huge item is capped at 900, so it doesn't monopolize the budget
  const firstLine = text.split("\n")[1];
  assert.ok(firstLine.length <= 901, `first item length ${firstLine.length} > 901`);
  assert.ok(text.includes("short-2"));
  assert.ok(!text.includes("short-3")); // 4th candidate dropped (l2MaxItems=3)
});

test("buildInjectedContext L2: last item truncated to remaining budget, not dropped", () => {
  // 3 items each ~850 chars → 2550 total, fits under 3000 with 3 items
  // then a scenario where 3rd item would overflow: use 2x1300 + 1x1300 (each capped to 900)
  // 900*3 = 2700 <= 3000 → all fit. Instead test global-cap squeeze via smaller cap.
  const cfg = { ...DEFAULT_CFG, maxInjectedCharsL2: 1000, l2PerItemCap: 900 };
  const mems = [
    makeMem(0, { abstract: "A".repeat(600) }),
    makeMem(1, { abstract: "B".repeat(600) }),
    makeMem(2, { abstract: "C".repeat(600) }),
  ];
  const { text, count, chars } = buildInjectedContext(cfg, "L2", mems);
  // A(600) fits; B needs 600 but only ~399 remain → B truncated to 399, C dropped.
  assert.equal(count, 2);
  assert.ok(chars <= 1000, `chars ${chars} > 1000`);
  assert.ok(text.includes("CC") === false);
});

// ---------------------------------------------------------------------------
// 9. NONE → injection 0
// ---------------------------------------------------------------------------
test("buildInjectedContext NONE: zero injection", () => {
  const mems = [makeMem(0)];
  const { text, count, chars } = buildInjectedContext(DEFAULT_CFG, "NONE", mems);
  assert.equal(text, "");
  assert.equal(count, 0);
  assert.equal(chars, 0);
});

// ---------------------------------------------------------------------------
// 11. deterministic order preserved (OpenViking ranking)
// ---------------------------------------------------------------------------
test("enrichSummaries + buildInjectedContext preserve ranking order", async () => {
  const fetchFn = async (url) => {
    if (String(url).includes("search/find")) throw new Error("unused");
    const m = String(url).match(/m(\d)\.md/);
    const i = m ? Number(m[1]) : 0;
    return resp({ result: rawWithSummary(`NATIVE-${i}`) });
  };
  const mems = [makeMem(0), makeMem(1), makeMem(2)];
  const enriched = await enrichSummaries(DEFAULT_CFG, mems, fetchFn);
  // summaries in original order
  assert.deepEqual(
    enriched.map((m) => m.summary),
    ["NATIVE-0", "NATIVE-1", "NATIVE-2"],
  );
  const { text } = buildInjectedContext(DEFAULT_CFG, "L1", enriched);
  const i0 = text.indexOf("NATIVE-0");
  const i1 = text.indexOf("NATIVE-1");
  const i2 = text.indexOf("NATIVE-2");
  assert.ok(i0 < i1 && i1 < i2, "order not preserved");
});

// ---------------------------------------------------------------------------
// 12. no MEMORY_FIELDS / raw ChatLog in the log line
// ---------------------------------------------------------------------------
test("buildEndLogLine: no memory content leaked", () => {
  const d = {
    gate: "L2",
    candidates: 5,
    summaries: 5,
    summaryFallbacks: 0,
    injectedItems: 3,
    injectedChars: 2400,
    topScores: [0.33, 0.31, 0.29],
  };
  const line = buildEndLogLine(d, true, 4);
  assert.ok(line.includes("gate=L2"));
  assert.ok(line.includes("candidates=5"));
  assert.ok(line.includes("summaries=5"));
  assert.ok(line.includes("summaryFallbacks=0"));
  assert.ok(line.includes("injectedItems=3"));
  assert.ok(line.includes("injectedChars=2400"));
  assert.ok(line.includes("topScores=[0.33,0.31,0.29]"));
  assert.ok(!line.includes("MEMORY_FIELDS"));
  assert.ok(!line.includes("ChatLog"));
});

// ---------------------------------------------------------------------------
// boundedJoin / capItem unit
// ---------------------------------------------------------------------------
test("capItem truncates to max", () => {
  assert.equal(capItem("abcdef", 3), "abc");
  assert.equal(capItem("   spaced   ", 4), "spac");
  assert.equal(capItem("", 5), "");
  assert.equal(capItem(null, 5), "");
});

test("boundedJoin: per-item + global caps, deterministic, no overshoot", () => {
  const { text, count } = boundedJoin(
    ["AAAA", "BBBB", "CCCC"],
    3, // per-item
    7, // global
  );
  // AAA + BBB = 6 chars + 1 sep = 7; CCC would need 4 → only 0 remaining → dropped
  assert.equal(count, 2);
  assert.equal(text, "AAA\nBBB");
});

// ---------------------------------------------------------------------------
// 10. Jev timeout → fail-open via runPipeline (imported indirectly)
// ---------------------------------------------------------------------------
test("runPipeline: Jev failure is fail-open (no injection, no throw)", async () => {
  // Import runPipeline lazily to keep top imports tidy.
  const { runPipeline } = await import("../index.js");

  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes("search/find")) {
      return resp({
        result: {
          memories: [makeMem(0, { abstract: "irrelevant detail" })],
        },
      });
    }
    if (u.includes("content/read")) {
      return resp({ result: rawWithSummary("some summary") });
    }
    // openrouter decisions → simulate timeout/error
    throw new Error("Jev API timeout");
  };

  const d = await runPipeline(DEFAULT_CFG, "test-key", "hello", fetchFn);
  assert.equal(d.gate, "NONE");
  assert.equal(d.injected, "");
  assert.equal(d.injectedChars, 0);
});

// ---------------------------------------------------------------------------
// STAGE 4.2 — buildContextualQuery
// ---------------------------------------------------------------------------

const msg = (role, content) => ({ role, content });

test("buildContextualQuery: only prompt (no messages) → prompt as query", () => {
  const r = buildContextualQuery({ prompt: "Сделано?", messages: [] });
  assert.equal(r.query, "Сделано?");
  assert.equal(r.queryMessages, 1);
  assert.equal(r.queryChars, "Сделано?".length);
  assert.equal(r.promptDedup, false);
});

test("buildContextualQuery: prompt absent from messages → appended as newest", () => {
  const r = buildContextualQuery({
    prompt: "Сделано?",
    messages: [
      msg("user", "Мы закончили STAGE 4.1 selective-memory"),
      msg("user", "Начинай STAGE 4.2"),
    ],
  });
  assert.equal(r.query, "Мы закончили STAGE 4.1 selective-memory\nНачинай STAGE 4.2\nСделано?");
  assert.equal(r.queryMessages, 3);
  assert.equal(r.promptDedup, false);
  assert.ok(r.query.includes("Сделано?"));
  assert.ok(r.query.includes("selective-memory"));
});

test("buildContextualQuery: prompt already present → dedup, no duplicate", () => {
  const r = buildContextualQuery({
    prompt: "Сделано?",
    messages: [
      msg("user", "Мы закончили STAGE 4.1 selective-memory"),
      msg("user", "Начинай STAGE 4.2"),
      msg("user", "Сделано?"),
    ],
  });
  assert.equal(r.promptDedup, true);
  assert.equal(r.queryMessages, 3);
  const count = r.query.split("Сделано?").length - 1;
  assert.equal(count, 1, "prompt must appear exactly once");
});

test("buildContextualQuery: 3 real user messages preserved (oldest→newest)", () => {
  const r = buildContextualQuery({
    prompt: "А дальше?",
    messages: [
      msg("user", "first message"),
      msg("user", "second message"),
      msg("user", "third message"),
    ],
  });
  // 3 messages + distinct prompt = 4 items → cap to 3, oldest dropped.
  assert.equal(r.queryMessages, 3);
  assert.ok(r.query.startsWith("second message"));
  assert.ok(r.query.endsWith("А дальше?"));
});

test("buildContextualQuery: >3 user messages → only last 3 kept", () => {
  const r = buildContextualQuery({
    prompt: "now",
    messages: [
      msg("user", "u1"),
      msg("user", "u2"),
      msg("user", "u3"),
      msg("user", "u4"),
    ],
  });
  assert.equal(r.queryMessages, 3);
  assert.ok(!r.query.includes("u1"));
  assert.ok(!r.query.includes("u2"));
  assert.ok(r.query.includes("u3"));
  assert.ok(r.query.includes("u4"));
  assert.ok(r.query.endsWith("now"));
});

test("buildContextualQuery: synthetic user blocks excluded", () => {
  const r = buildContextualQuery({
    prompt: "Сделано?",
    messages: [
      msg("user", "[Session History Summary] ... (compressed)"),
      msg("user", "OpenClaw runtime context ..."),
      msg("user", "[selective memory context — reference material]"),
      msg("user", "Мы закончили STAGE 4.1"),
    ],
  });
  assert.equal(r.queryMessages, 2); // real + prompt
  assert.ok(!r.query.includes("Session History Summary"));
  assert.ok(!r.query.includes("runtime context"));
  assert.ok(!r.query.includes("selective memory context"));
  assert.ok(r.query.includes("Мы закончили STAGE 4.1"));
  assert.ok(r.query.endsWith("Сделано?"));
});

test("buildContextualQuery: assistant/toolResult excluded", () => {
  const r = buildContextualQuery({
    prompt: "Почему?",
    messages: [
      msg("user", "Мы закончили STAGE 4.1"),
      msg("assistant", "Отлично, продолжаем"),
      msg("toolResult", "[tool output here]"),
      msg("user", "Начинай STAGE 4.2"),
    ],
  });
  assert.equal(r.queryMessages, 3);
  assert.ok(!r.query.includes("Отлично"));
  assert.ok(!r.query.includes("tool output"));
});

test("buildContextualQuery: maxQueryChars enforced, newest preserved on truncation", () => {
  const long = "x".repeat(900);
  const r = buildContextualQuery(
    {
      prompt: "Сделано?",
      messages: [
        msg("user", long), // oldest
        msg("user", "Мы закончили STAGE 4.1"),
      ],
    },
    { maxQueryChars: 1000, maxMessages: 3 },
  );
  assert.ok(r.queryChars <= 1000, `queryChars ${r.queryChars} > 1000`);
  assert.ok(r.query.endsWith("Сделано?"), "newest message must be preserved");
  assert.ok(r.query.includes("Мы закончили STAGE 4.1"));
});

test("buildContextualQuery: newest single message over budget is truncated not dropped", () => {
  const r = buildContextualQuery(
    { prompt: "y".repeat(2000), messages: [] },
    { maxQueryChars: 1000, maxMessages: 3 },
  );
  assert.equal(r.query.length, 1000);
  assert.equal(r.queryMessages, 1);
});

test("buildContextualQuery: malformed messages → fallback to prompt", () => {
  assert.equal(buildContextualQuery({ prompt: "Проверь", messages: null }).query, "Проверь");
  assert.equal(buildContextualQuery({ prompt: "Проверь", messages: "garbage" }).query, "Проверь");
  assert.equal(
    buildContextualQuery({ prompt: "Проверь", messages: ["not-an-object"] }).query,
    "Проверь",
  );
});

test("buildContextualQuery: all-synthetic messages → fallback to prompt", () => {
  const r = buildContextualQuery({
    prompt: "Сделано?",
    messages: [msg("user", "[Session History Summary]"), msg("assistant", "hi")],
  });
  assert.equal(r.query, "Сделано?");
  assert.equal(r.queryMessages, 1);
});

test("buildContextualQuery: promptDedup ignores whitespace/case differences", () => {
  const r = buildContextualQuery({
    prompt: "  Сделано? ",
    messages: [msg("user", "сделано?")],
  });
  assert.equal(r.promptDedup, true);
  assert.equal(r.queryMessages, 1);
});

test("isSyntheticUserText / messageText helpers", () => {
  assert.equal(isSyntheticUserText("[Session History Summary] foo"), true);
  assert.equal(isSyntheticUserText("OpenClaw runtime context foo"), true);
  assert.equal(isSyntheticUserText("[selective memory context foo"), true);
  assert.equal(isSyntheticUserText("Мы закончили STAGE 4.1"), false);
  assert.equal(messageText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(messageText("plain"), "plain");
  assert.equal(messageText(null), "");
});

// ---------------------------------------------------------------------------
// STAGE 4.2 ITERATION 2 — classifyPromptContext + buildAdaptiveQuery
// ---------------------------------------------------------------------------

const CONTEXTUAL_PROMPTS = [
  "Сделано?",
  "Почему?",
  "А дальше?",
  "Проверь",
  "Это правильно?",
  "И что теперь?",
  "Продолжай",
  "готово?",
  "Почему это?",
  "проверь",
  "done?",
  "why?",
  "next",
  "What now?",
];

const CURRENT_PROMPTS = [
  "nginx reverse proxy 443",
  "Почему nginx 502?",
  "Проверь nginx",
  "OpenViking summary API",
  "Jev timeout 5000",
  "systemctl status nginx",
  "/etc/nginx/nginx.conf",
  "https://example.com",
  "Сделано в STAGE 4.1?",
  "selective-memory plugin",
  "192.168.31.216",
  "~/projects/app",
];

test("classifyPromptContext: context-dependent prompts → useHistory=true", () => {
  for (const p of CONTEXTUAL_PROMPTS) {
    const r = classifyPromptContext(p);
    assert.equal(r.useHistory, true, `expected contextual: ${p} (reason=${r.reason})`);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  }
});

test("classifyPromptContext: standalone-subject prompts → useHistory=false", () => {
  for (const p of CURRENT_PROMPTS) {
    const r = classifyPromptContext(p);
    assert.equal(r.useHistory, false, `expected current: ${p} (reason=${r.reason})`);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  }
});

test("classifyPromptContext: subject wins over context marker", () => {
  assert.equal(classifyPromptContext("Почему?").useHistory, true);
  assert.equal(classifyPromptContext("Почему nginx 502?").useHistory, false);
  assert.equal(classifyPromptContext("Проверь").useHistory, true);
  assert.equal(classifyPromptContext("Проверь nginx").useHistory, false);
  assert.equal(classifyPromptContext("Сделано?").useHistory, true);
  assert.equal(classifyPromptContext("Сделано в STAGE 4.1?").useHistory, false);
});

test("classifyPromptContext: structural signals → current", () => {
  assert.equal(classifyPromptContext("https://example.com").reason, "structural-subject");
  assert.equal(classifyPromptContext("10.0.0.5").reason, "structural-subject");
  assert.equal(classifyPromptContext("v1.2.3").reason, "structural-subject");
  assert.equal(classifyPromptContext("порт 8080").reason, "structural-subject");
  assert.equal(classifyPromptContext("/etc/nginx/nginx.conf").reason, "structural-subject");
});

test("classifyPromptContext: empty / non-string → default current", () => {
  assert.deepEqual(classifyPromptContext(""), { useHistory: false, reason: "empty" });
  assert.equal(classifyPromptContext(null).useHistory, false);
  assert.equal(classifyPromptContext("!!!").useHistory, false);
});

test("buildAdaptiveQuery: contextual → uses history (current + previous real users)", () => {
  const r = buildAdaptiveQuery({
    prompt: "Сделано?",
    messages: [
      msg("user", "Мы закончили STAGE 4.1 selective-memory"),
      msg("user", "Начинай STAGE 4.2"),
      msg("user", "Сделано?"),
    ],
  });
  assert.equal(r.queryMode, "contextual");
  assert.equal(r.queryReason, "context-dependent");
  assert.equal(r.promptDedup, true);
  assert.ok(r.query.includes("selective-memory"));
  assert.ok(r.query.includes("Начинай STAGE 4.2"));
});

test("buildAdaptiveQuery: contextual caps history at current + 2 previous", () => {
  const r = buildAdaptiveQuery(
    {
      prompt: "Почему?",
      messages: [
        msg("user", "older-1"),
        msg("user", "older-2"),
        msg("user", "prev-1"),
        msg("user", "prev-2"),
      ],
    },
    { maxMessages: 3, maxQueryChars: 1000 },
  );
  assert.equal(r.queryMode, "contextual");
  assert.equal(r.queryMessages, 3);
  assert.ok(!r.query.includes("older-1"));
  assert.ok(!r.query.includes("older-2"));
  assert.ok(r.query.includes("prev-1"));
  assert.ok(r.query.includes("prev-2"));
  assert.ok(r.query.endsWith("Почему?"));
});

test("buildAdaptiveQuery: current → prompt only, no history", () => {
  const r = buildAdaptiveQuery({
    prompt: "nginx reverse proxy 443",
    messages: [
      msg("user", "Мы закончили STAGE 4.1 selective-memory"),
      msg("user", "Начинай STAGE 4.2"),
    ],
  });
  assert.equal(r.queryMode, "current");
  assert.equal(r.query, "nginx reverse proxy 443");
  assert.equal(r.queryMessages, 1);
  assert.equal(r.promptDedup, false);
  assert.ok(!r.query.includes("selective-memory"));
});

test("buildAdaptiveQuery: malformed messages + contextual → fallback to prompt", () => {
  const r = buildAdaptiveQuery({ prompt: "Проверь", messages: null });
  assert.equal(r.queryMode, "contextual");
  assert.equal(r.query, "Проверь");
  assert.equal(r.queryMessages, 1);
});

test("buildAdaptiveQuery: maxQueryChars respected, newest preserved", () => {
  const r = buildAdaptiveQuery(
    {
      prompt: "Сделано?",
      messages: [msg("user", "x".repeat(900)), msg("user", "контекст")],
    },
    { maxMessages: 3, maxQueryChars: 1000 },
  );
  assert.ok(r.queryChars <= 1000);
  assert.ok(r.query.endsWith("Сделано?"));
});

test("buildEndLogLine: carries queryMode/queryReason, no query text", () => {
  const line = buildEndLogLine(
    {
      gate: "L1",
      candidates: 3,
      injectedItems: 2,
      injectedChars: 120,
      queryMode: "contextual",
      queryReason: "context-dependent",
      queryMessages: 3,
      queryChars: 88,
      promptDedup: true,
      topScores: [0.5],
    },
    true,
    5,
  );
  assert.ok(line.includes("queryMode=contextual"));
  assert.ok(line.includes("queryReason=context-dependent"));
  assert.ok(line.includes("queryMessages=3"));
  assert.ok(line.includes("promptDedup=true"));
  // No query *content* leak: only the fixed "queryChars=N" key, never the text.
  assert.ok(!line.includes("Сделано"));
  assert.ok(!line.includes("query=\""));
});
