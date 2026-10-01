// selective-memory — STAGE 5.1 write/gate.js
//
// Write Gate: per-candidate KEEP / SKIP with a reason code. Fail-closed:
// anything uncertain → SKIP. The SECRET reason is a defense-in-depth re-check
// (the secret-filter already redacts before extraction, but if anything slips
// through, we refuse to keep it).

import { scanSecrets } from "./secret-filter.js";

export const SKIP_REASONS = {
  SECRET: "SECRET",
  TEMPORARY: "TEMPORARY",
  NOISE: "NOISE",
  NO_LONG_TERM_VALUE: "NO_LONG_TERM_VALUE",
  LOW_CONFIDENCE: "LOW_CONFIDENCE",
  UNSUPPORTED: "UNSUPPORTED",
};

const NOISE_MARKERS = [
  /Traceback\s*\(most recent call last\)/i,
  /Exception in thread/i,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|KeyError|ValueError|AttributeError)\s*:/,
  /^\s*at\s+\S+\s+\(/m,           // JS/Java stack frame
  /goroutine\s+\d+\b/i,
  /\bpanic:\s+/i,
  /\b(ERROR|FATAL|CRITICAL)\b\s*:/,
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/, // log timestamps
  /\[(?:ERROR|WARN|WARNING|INFO|DEBUG)\]/i,
  /Caused by:/i,
  /\b(?:stdout|stderr|log\.(?:error|warn|info|debug))\b/i,
];

const SMALLTALK_RE = /^(?:привет|здравствуй|здравствуйте|пока|спасибо|благодарю|ок|окей|ага|угу|да|нет|hi|hello|hey|thanks|thank you|ok|okay|bye|yes|no)[\s.!?]*$/i;

/**
 * Text-level classification of a sanitised turn.
 * @param {string} text  sanitised text
 * @param {{noiseMinChars?: number}} cfg
 * @returns {{isNoise: boolean, isSmalltalk: boolean, length: number}}
 */
export function classifyTurn(text, cfg = {}) {
  const noiseMinChars = typeof cfg.noiseMinChars === "number" ? cfg.noiseMinChars : 1200;
  const t = typeof text === "string" ? text : "";
  const trimmed = t.trim();
  const isNoise = trimmed.length >= noiseMinChars || NOISE_MARKERS.some((re) => re.test(t));
  const isSmalltalk = SMALLTALK_RE.test(trimmed);
  return { isNoise, isSmalltalk, length: trimmed.length };
}

/**
 * Decide KEEP / SKIP for one candidate.
 * @param {object} candidate
 * @param {{isNoise?: boolean, isSmalltalk?: boolean}} cls  (unused today; kept for symmetry)
 * @param {{lowConfidenceThreshold?: number}} cfg
 * @returns {{decision: "KEEP"|"SKIP", reason: string|null}}
 */
export function gateCandidate(candidate, _cls = {}, cfg = {}) {
  const threshold =
    typeof cfg.lowConfidenceThreshold === "number" ? cfg.lowConfidenceThreshold : 0.5;

  // Defense-in-depth: never keep anything that still carries a secret.
  if (scanSecrets(typeof candidate?.value === "string" ? candidate.value : "").found) {
    return { decision: "SKIP", reason: SKIP_REASONS.SECRET };
  }

  if (candidate?.type === "state") {
    return { decision: "SKIP", reason: SKIP_REASONS.TEMPORARY };
  }

  if (candidate?.type === "preference") {
    if (typeof candidate.confidence !== "number" || candidate.confidence < threshold) {
      return { decision: "SKIP", reason: SKIP_REASONS.LOW_CONFIDENCE };
    }
    if (typeof candidate.value !== "string" || candidate.value.length < 2) {
      return { decision: "SKIP", reason: SKIP_REASONS.NO_LONG_TERM_VALUE };
    }
    return { decision: "KEEP", reason: null };
  }

  return { decision: "SKIP", reason: SKIP_REASONS.UNSUPPORTED };
}
