// selective-memory — STAGE 5.1/5.3 write/extract.js
//
// Deterministic candidate extraction (NO LLM). Operates on SANITISED text only:
// the secret-filter has already run and redacted any secret before this module
// is invoked. Output is always a structured candidate, never free text.
//
// Candidate shape (minimal per STAGE 5.1, extended 5.3):
//   { entity, property, value, source_type, confidence, timestamp, type }
//   type ∈ { preference, state }  — internal, used by the gate (dropped from trace).
//   source_type ∈ { user_stated, user_correction, user_refinement } (STAGE 5.3).

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Hedging words → halve confidence (an uncertain fact should not be written).
const HEDGE_WORDS = [
  "наверное", "наверно", "возможно", "может быть", "может", "вроде", "кажется",
  "скорее всего", "по-моему", "по моему", "думаю", "не уверен", "не уверена",
  "примерно", "вроде бы", "наверняка", "сложно сказать",
  "maybe", "perhaps", "probably", "i think", "i guess", "not sure", "kind of",
  "sort of", "seem", "seems", "might", "could be",
];

function hasHedge(text) {
  const t = text.toLowerCase();
  return HEDGE_WORDS.some((w) => t.includes(w));
}

function hedge(text, conf) {
  return hasHedge(text) ? Math.round(conf * 0.5 * 100) / 100 : conf;
}

// Domain nouns → normalized property suffix. Sorted longest-first so
// "редактор кода" wins over "редактор".
const DOMAINS = [
  ["редактор кода", "editor"], ["редактор", "editor"], ["editor", "editor"], ["ide", "editor"],
  ["язык программирования", "language"], ["язык", "language"], ["language", "language"],
  ["браузер", "browser"], ["browser", "browser"],
  ["операционная система", "os"], ["операционную систему", "os"], ["операционка", "os"],
  ["город", "city"], ["city", "city"],
  ["цвет", "color"], ["color", "color"],
  ["еда", "food"], ["блюдо", "food"], ["food", "food"],
  ["фильм", "movie"], ["movie", "movie"],
  ["музыка", "music"], ["music", "music"],
  ["хобби", "hobby"], ["hobby", "hobby"],
  ["имя", "name"], ["name", "name"],
  ["профессия", "profession"], ["profession", "profession"],
].sort((a, b) => b[0].length - a[0].length);

const LETTER = /[a-zа-яё0-9]/i;

// Known value → semantic property, used when the value carries no domain noun
// (e.g. "предпочитаю VS Code" → preferred_editor; "люблю Python" → preferred_language).
const KNOWN_EDITORS = new Set([
  "vs code", "visual studio code", "vscode", "vim", "neovim", "emacs", "sublime text",
  "sublime", "notepad++", "jetbrains", "intellij", "pycharm", "webstorm", "phpstorm",
  "goland", "rider", "clion", "atom", "nano", "zed", "cursor",
]);
const KNOWN_LANGUAGES = new Set([
  "python", "javascript", "js", "typescript", "ts", "go", "golang", "rust", "java",
  "c", "c++", "cpp", "c#", "csharp", "php", "ruby", "swift", "kotlin", "scala",
  "perl", "lua", "r", "haskell", "elixir", "clojure", "dart", "sql", "bash", "shell", "zsh",
]);

function classifyKnownValue(value) {
  const v = value.toLowerCase();
  if (KNOWN_EDITORS.has(v)) return "preferred_editor";
  if (KNOWN_LANGUAGES.has(v)) return "preferred_language";
  return null;
}

// Find a domain noun in text with word-boundary checks (ASCII \b does not cover
// Cyrillic, so we check the neighbours manually). Returns {prop,start,end} | null.
export function findDomain(text) {
  const t = text.toLowerCase();
  for (const [key, prop] of DOMAINS) {
    let from = 0;
    let i;
    while ((i = t.indexOf(key, from)) !== -1) {
      const before = i === 0 ? "" : t[i - 1];
      const after = i + key.length < t.length ? t[i + key.length] : "";
      const okBefore = i === 0 || !LETTER.test(before);
      const okAfter = !LETTER.test(after);
      if (okBefore && okAfter) return { prop, start: i, end: i + key.length };
      from = i + key.length;
    }
  }
  return null;
}

// Strip surrounding quotes, cut at the first clause break, drop trailing
// punctuation and a leading copula ("это"/"is"/"—").
export function cleanValue(raw) {
  if (typeof raw !== "string") return "";
  let v = raw.replace(/^[\s"']+|[\s"']+$/g, "");
  v = v.split(/[,;]/)[0];
  v = v.replace(/[.!?\s]+$/g, "");
  v = v.replace(/^(?:это|этот|is|—|–|-|:)\s*/i, "");
  v = v.replace(/\s+/g, " ").trim();
  return v;
}

// Assign a semantic property for a bare value: domain noun wins, else a known
// editor/language mapping, else generic "preference".
function assignProperty(value) {
  let v = value;
  let property = "preference";
  const dom = findDomain(v);
  if (dom) {
    property = `preferred_${dom.prop}`;
    const stripped = cleanValue(v.slice(dom.end));
    if (stripped) v = stripped;
  } else {
    const known = classifyKnownValue(v);
    if (known) property = known;
  }
  return { property, value: v };
}

const PREFERENCE_VERBS = [
  { verb: "предпочитаю", conf: 0.9 },
  { verb: "предпочитает", conf: 0.85 },
  { verb: "люблю", conf: 0.85 },
  { verb: "пользуюсь", conf: 0.8 },
  { verb: "использую", conf: 0.8 },
  { verb: "сижу на", conf: 0.8 },
  { verb: "работаю в", conf: 0.8 },
  { verb: "работаю на", conf: 0.8 },
  { verb: "работаю с", conf: 0.8 },
  { verb: "пишу на", conf: 0.8 },
  { verb: "пишу в", conf: 0.8 },
  { verb: "живу в", conf: 0.9 },
  { verb: "живу на", conf: 0.9 },
  { verb: "мне нравится", conf: 0.8 },
  { verb: "prefer", conf: 0.9 },
  { verb: "like", conf: 0.7 },
  { verb: "love", conf: 0.85 },
  { verb: "use", conf: 0.8 },
  { verb: "using", conf: 0.8 },
].sort((a, b) => b.verb.length - a.verb.length);

const NEGATION_RE = /(?:^|\s)не\s+(предпочитаю|люблю|пользуюсь|использую|нравится|prefer|like|use)/i;

function extractPreference(clause) {
  const text = clause.trim();
  if (!text) return null;

  // Negation ("я НЕ предпочитаю X") is not a preference.
  if (NEGATION_RE.test(text)) return null;

  // P2 — possessive "my favorite <domain> <value>".
  const p2 = text.match(
    /^(?:my|мой|моя|моё|мои|наш)\s+(?:favorite|favourite|любим\w*|основн\w*|главн\w*|предпочитаем\w*)\s+(.+)$/i,
  );
  if (p2) {
    const rest = p2[1];
    const dom = findDomain(rest);
    if (dom) {
      const value = cleanValue(rest.slice(dom.end));
      if (value) {
        return { type: "preference", property: `preferred_${dom.prop}`, value, conf: hedge(text, 0.85), source_type: "user_stated" };
      }
    }
  }

  // P1 — verb-led preference. Match the verb anywhere (hedge words may precede).
  for (const { verb, conf } of PREFERENCE_VERBS) {
    const re = new RegExp(`(?:^|\\s)${escapeRe(verb)}\\s+(.+)$`, "i");
    const m = text.match(re);
    if (!m) continue;
    let value = cleanValue(m[1]);
    if (!value) continue;
    const { property, value: v2 } = assignProperty(value);
    return { type: "preference", property, value: v2, conf: hedge(text, conf), source_type: "user_stated" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// STAGE 5.3 — source-type aware extraction (correction / refinement / history)
// ---------------------------------------------------------------------------

// A clause that begins with one of these is a statement about the PAST and must
// not become current memory. ("раньше"/"прежде"/"used to" …)
const HISTORICAL_MARKERS = [
  "раньше", "до этого", "прежде", "когда-то", "в прошлом", "давно",
  "used to", "previously", "in the past",
];

// Explicit correction of a prior fact → user_correction (trust 0.99). Ordered
// longest-first so "перешёл на" is matched before "теперь".
const CORRECTION_PREFIXES = [
  "переключился на", "переключилась на",
  "перешёл на", "перешла на", "перешло на",
  "сменил на", "сменила на",
  "заменил на", "заменила на",
  "обновил на", "обновила на",
  "переехал на", "переехала на",
  "switched to", "moved to", "changed to", "replaced with",
  "теперь", "отныне",
];

// Compatible (additive) refinement → user_refinement (trust 0.95).
const REFINEMENT_PREFIXES = [
  "дополнительно", "вдобавок", "а ещё", "и ещё", "также", "тоже", "ещё", "плюс",
  "additionally", "as well as", "also", "plus", "too",
];

// Leading verb/preposition that may follow a source-type marker and precede the
// actual value. Stripped before value extraction.
const LEADING_VERBS_RE = /^(?:предпочитаю|предпочитает|использую|использовал\w*|пользуюсь|люблю|мне нравится|работаю в|работаю на|работаю с|сижу на|живу в|живу на|пишу на|пишу в|prefer|use|using|like|love|на|с|to)\s+/i;

/** Return the marker string if `text` starts with one of `markers` at a word
 *  boundary (so "раньшевик" does not match "раньше"). */
function leadingMarker(text, markers) {
  const t = text.toLowerCase();
  for (const m of markers) {
    if (!t.startsWith(m)) continue;
    const after = t.slice(m.length);
    if (after.length === 0) return m;
    if (!LETTER.test(after[0])) return m;
  }
  return null;
}

/** True when the clause is about the past and should not yield a current value. */
export function isHistoricalClause(text) {
  return leadingMarker(text.trim(), HISTORICAL_MARKERS) !== null;
}

function buildFromMarker(text, marker, conf, source_type) {
  let rest = text.slice(marker.length).replace(/^[\s,:;—-]+/, "");
  // Drop a leading pronoun ("теперь я использую X" → "X").
  rest = rest.replace(/^(?:я|мы)\s+/i, "");
  rest = rest.replace(LEADING_VERBS_RE, "");
  const value = cleanValue(rest);
  if (!value) return null;
  const { property, value: v2 } = assignProperty(value);
  return { type: "preference", property, value: v2, conf, source_type };
}

function extractCorrection(clause) {
  const text = clause.trim();
  if (!text) return null;
  const marker = leadingMarker(text, CORRECTION_PREFIXES);
  if (!marker) return null;
  return buildFromMarker(text, marker, 0.99, "user_correction");
}

function extractRefinement(clause) {
  const text = clause.trim();
  if (!text) return null;
  const marker = leadingMarker(text, REFINEMENT_PREFIXES);
  if (!marker) return null;
  return buildFromMarker(text, marker, 0.9, "user_refinement");
}

// ---------------------------------------------------------------------------
// State (transient) extraction
// ---------------------------------------------------------------------------

const WEATHER = new Set([
  "дождь", "снег", "солнце", "солнечно", "облачно", "ветер", "ветрено", "жарко",
  "холодно", "тепло", "мороз", "гроза", "туман", "rain", "snow", "sunny", "cloudy",
  "windy", "hot", "cold", "storm", "fog",
]);

const STATUS_VERBS = [
  "перезапустил", "перезапустился", "перезагрузил", "перезагрузился", "грузится",
  "загружается", "завис", "висит", "упал", "упала", "падает", "сломался", "сломалась",
  "restarting", "restarted", "rebooting", "rebooted", "down", "crashed", "hangs",
];

function extractState(clause) {
  const text = clause.trim();
  const m = text.match(
    /^(?:сегодня|сейчас|завтра|вчера|нынче|этой ночью|утром|вечером|today|now|tomorrow|yesterday)\s+(.+)$/i,
  );
  if (m) {
    const value = cleanValue(m[1]);
    if (!value) return null;
    const weather = WEATHER.has(value.toLowerCase());
    return { type: "state", property: weather ? "weather" : "transient_state", value, conf: 0.7, source_type: "user_stated" };
  }
  for (const s of STATUS_VERBS) {
    if (new RegExp(`(?:^|\\s)${escapeRe(s)}\\b`, "i").test(text)) {
      return { type: "state", property: "status", value: text, conf: 0.7, source_type: "user_stated" };
    }
  }
  return null;
}

function toCandidate(c, timestamp) {
  return {
    entity: "user",
    property: c.property,
    value: c.value,
    source_type: c.source_type || "user_stated",
    confidence: c.conf,
    timestamp,
    type: c.type,
  };
}

/**
 * Extract structured candidates from already-sanitised text.
 * @param {string} safeText  text after secret-filter redaction
 * @param {{timestamp?: string, turnId?: string}} opts
 * @returns {Array} candidates
 */
export function extractCandidates(safeText, { timestamp = new Date().toISOString() } = {}) {
  if (typeof safeText !== "string" || !safeText.trim()) return [];
  const clauses = safeText
    .split(/[.,;!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const clause of clauses) {
    if (!clause) continue;
    // Historical clause ("раньше X") → never a current-value candidate (STAGE 5.3).
    if (isHistoricalClause(clause)) continue;

    const corr = extractCorrection(clause);
    if (corr) { out.push(toCandidate(corr, timestamp)); continue; }

    const ref = extractRefinement(clause);
    if (ref) { out.push(toCandidate(ref, timestamp)); continue; }

    const pref = extractPreference(clause);
    if (pref) { out.push(toCandidate(pref, timestamp)); continue; }

    const st = extractState(clause);
    if (st) out.push(toCandidate(st, timestamp));
  }
  return out;
}
