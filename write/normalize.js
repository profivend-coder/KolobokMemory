// selective-memory — STAGE 5.2 write/normalize.js
//
// Safe, NON-semantic normalization for dedup comparison. Only reversible,
// meaning-preserving transforms are applied:
//   - Unicode NFC normalization
//   - lowercase
//   - ё → е (standard Russian equivalence)
//   - curly quotes / guillemets → straight quotes
//   - Unicode spaces → ASCII space, collapse runs
//   - trim + strip surrounding quotes/dashes/colon and trailing punctuation
//
// Deliberately NOT done: synonym expansion, stemming, "VS Code" ↔
// "Visual Studio Code", number/unit conversion. Those change meaning and belong
// to a semantic layer — here we fail-closed (see isSimilar) instead.

export function normalizeValue(v) {
  if (typeof v !== "string") return "";
  let s = v;
  try {
    s = s.normalize("NFC");
  } catch {
    /* keep original on unsupported input */
  }
  s = s.toLowerCase();
  s = s.replace(/\u0451/g, "\u0435"); // ё → е
  s = s.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  s = s.replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"');
  s = s.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, " ");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/^[\s"'\-–—:]+|[\s"'\-–—:]+$/g, "");
  s = s.replace(/[.,;:!?…]+$/g, "");
  return s.trim();
}

export function tokenize(v) {
  const n = normalizeValue(v);
  if (!n) return [];
  return n.split(/[^a-zа-яё0-9]+/).filter(Boolean);
}

/** Exact equivalence after normalization. */
export function valuesEquivalent(a, b) {
  const na = normalizeValue(a);
  const nb = normalizeValue(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * "Close but NOT provably equal" — used to fail-closed into AMBIGUOUS rather
 * than confidently declaring NOVEL. Conservative: substring containment or
 * ≥50% token overlap.
 */
export function isSimilar(a, b) {
  const na = normalizeValue(a);
  const nb = normalizeValue(b);
  if (!na || !nb || na === nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = tokenize(na);
  const tb = tokenize(nb);
  if (ta.length === 0 || tb.length === 0) return false;
  const sb = new Set(tb);
  let inter = 0;
  for (const t of ta) if (sb.has(t)) inter++;
  const minLen = Math.min(ta.length, tb.length);
  return minLen > 0 && inter / minLen >= 0.5;
}
