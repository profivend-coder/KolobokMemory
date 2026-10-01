// selective-memory — STAGE 5.1 WRITE FOUNDATION / SHADOW MODE
//
// Deterministic secret detection + redaction.
//
// Runs BEFORE any candidate extraction (and before any future LLM step), so a
// secret never reaches the extractor or the trace. A secret is REDACTED, not
// used as a reason to drop the whole turn: the safe remainder is still
// processed. Fail-closed: when in doubt, redact.
//
// Detects (deterministically, no LLM):
//   - API keys          (sk-…, pk_…, AKIA…, AIza…, ghp_…, xox…-…)
//   - bearer / Basic tokens, Authorization headers
//   - passwords         (password=, passwd=, пароль …)
//   - cookies / session ids / csrf tokens
//   - access/refresh/auth tokens, client secrets
//   - JWT (eyJ…)
//   - one-time / verification codes (otp / 2fa / код + digits)
//   - PEM private keys  (-----BEGIN … PRIVATE KEY-----)

export const REDACTED = "[REDACTED]";

// Credential-ish keys that, when followed by `=` or `:`, mark the value as a
// secret. Kept narrow on purpose (a bare "key"/"token" is too noisy).
const CREDENTIAL_KEYS = [
  "password", "passwd", "pwd", "pass",
  "api[_-]?key", "apikey",
  "access[_-]?token", "refresh[_-]?token", "auth[_-]?token", "id[_-]?token",
  "client[_-]?secret", "app[_-]?secret", "secret[_-]?key", "secret",
  "session[_-]?id", "sessionid", "session[_-]?token", "session[_-]?secret",
  "cookie", "csrf[_-]?token", "csrftoken",
  "jwt",
  "пароль",
];

const CRED_KEY_RE = new RegExp(
  `(${CREDENTIAL_KEYS.join("|")})\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,;]+))`,
  "gi",
);

// password-ish keyword followed directly by a value (no = / :) — RU/EN.
// The value must contain a digit (passwords/OTP almost always do), which avoids
// redacting innocent prose like "password manager".
const PW_BARE_RE = /(пароль|password|passwd|pwd)\s+["']?([^\s,;]*\d[^\s,;]*)["']?/gi;

// Well-known standalone secret token formats.
const KNOWN_TOKEN_RES = [
  { re: /\bsk[-_](?:live|test|or(?:-v\d+)?|svcacct)?[-_]?[A-Za-z0-9]{4,}\b/g, type: "api_key" },
  { re: /\bpk[-_][A-Za-z0-9]{4,}\b/g, type: "api_key" },
  { re: /\brk[-_]live[-_][A-Za-z0-9]{4,}\b/g, type: "api_key" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, type: "aws_access_key" },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, type: "google_api_key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, type: "github_token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, type: "github_token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, type: "slack_token" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, type: "jwt" },
];

// Authorization: Bearer … / Authorization: Basic … / bare Bearer … (value redacted).
const AUTH_RE = /\b(?:Authorization\s*:\s*|Bearer\s+)(?:Bearer\s+|Basic\s+)?[A-Za-z0-9._\-\/+=]+/gi;

// PEM private key blocks (multiline).
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;

// One-time / verification codes — digits redacted, keyword kept.
const OTP_ASCII_RE = /\b(?:otp|one[-\s]?time|verification|confirmation|2fa|mfa|code)\b\s*[:=]?\s*\d{4,8}\b/gi;
const OTP_CYR_RE = /(?:одноразов[а-я]*\s*код|код\s*подтверждени[а-я]*|смс[-\s]?код|код)\s*[:=]?\s*\d{4,8}/gi;

/**
 * Scan text for secrets and return a redacted copy plus the list of detected
 * secret types. Deterministic, no network, no LLM.
 *
 * @param {string} text
 * @returns {{ safeText: string, secrets: Array<{type:string, key?:string}>, found: boolean }}
 */
export function scanSecrets(text) {
  if (typeof text !== "string" || !text) {
    return { safeText: "", secrets: [], found: false };
  }

  const secrets = [];
  let out = text;

  // 1. credential assignment (key=value / key: value) — keep the key, redact value.
  out = out.replace(CRED_KEY_RE, (_m, key) => {
    secrets.push({ type: "credential_assignment", key: String(key).toLowerCase() });
    return `${key}=${REDACTED}`;
  });

  // 2. bare password keyword + value (value must contain a digit).
  out = out.replace(PW_BARE_RE, (_m, key) => {
    secrets.push({ type: "password" });
    return `${key} ${REDACTED}`;
  });

  // 3. known standalone token formats.
  for (const { re, type } of KNOWN_TOKEN_RES) {
    out = out.replace(re, () => {
      secrets.push({ type });
      return REDACTED;
    });
  }

  // 4. Authorization / Bearer headers.
  out = out.replace(AUTH_RE, () => {
    secrets.push({ type: "authorization_header" });
    return REDACTED;
  });

  // 5. PEM private key blocks.
  out = out.replace(PRIVATE_KEY_RE, () => {
    secrets.push({ type: "private_key" });
    return REDACTED;
  });

  // 6. OTP / verification codes — keep keyword, redact digits.
  out = out.replace(OTP_ASCII_RE, (m) => {
    secrets.push({ type: "otp" });
    return m.replace(/\d{4,8}/g, REDACTED);
  });
  out = out.replace(OTP_CYR_RE, (m) => {
    secrets.push({ type: "otp" });
    return m.replace(/\d{4,8}/g, REDACTED);
  });

  return { safeText: out, secrets, found: secrets.length > 0 };
}
