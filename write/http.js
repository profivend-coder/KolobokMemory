// selective-memory — STAGE 5.4 write/http.js
//
// Minimal OpenViking HTTP client for the writer. Isolated from the production
// read-path (`../index.js` is NOT imported here): this module owns its own
// fetch, error handling and idempotency support.
//
// Real API surface used (verified against the live openapi.json, 2026-10-01):
//   POST /api/v1/fs/mkdir        { uri }
//   POST /api/v1/content/write   { uri, content, mode: create|replace|append, wait }
//   POST /api/v1/fs/mv           { from_uri, to_uri }
//   DELETE /api/v1/fs?uri=...&recursive=true
//   GET  /api/v1/content/read?uri=...&raw=true
//   GET  /api/v1/fs/stat?uri=...
//   GET  /api/v1/fs/ls?uri=...&simple=true
//   POST /api/v1/search/grep     { uri, pattern }
//   POST /api/v1/search/glob     { uri, pattern }
//   POST /api/v1/search/find     { query, limit, score_threshold, target_uri }
//
// Notable live-API facts captured by STAGE 5.4 (do NOT rely on assumptions):
//   - content/write mode "upsert" is NOT supported (INVALID_ARGUMENT). The
//     writer therefore implements idempotency itself via a journal.
//   - content/write mode "create" returns ALREADY_EXISTS on a duplicate URI.
//   - content/write auto-creates missing parent directories (no mkdir needed).
//   - fs/mv OVERWRITES the destination if it exists (no rename-only semantics);
//     the writer guards against this by naming history files by their version.
//   - MEMORY_FIELDS tail comments round-trip byte-for-byte through content/write.
//
// This module does NOT mutate. It only exposes fetch primitives; mutation policy
// lives in writer.js.

const DEFAULT_BASE = "http://127.0.0.1:1933";
const DEFAULT_KEY = "local-dev";
const DEFAULT_TIMEOUT_MS = 15000;

function str(v, d) {
  return typeof v === "string" && v.trim() ? v.trim() : d;
}

/**
 * A small response wrapper with error classification.
 */
export class OvError extends Error {
  constructor(message, { code = null, status = null, body = null } = {}) {
    super(message);
    this.name = "OvError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

function classify(res, body, method, url) {
  if (res.ok) return null;
  let code = null;
  let message = "";
  if (body && typeof body === "object") {
    code = body?.error?.code ?? body?.code ?? null;
    message = body?.error?.message ?? body?.message ?? "";
  }
  if (!message) message = `HTTP ${res.status} from ${method} ${url}`;
  return new OvError(message, { code, status: res.status, body });
}

/**
 * Create an OpenViking client bound to a writer config.
 * @param {object} cfg  { baseUrl?, apiKey?, timeoutMs?, fetchFn? }
 */
export function createClient(cfg = {}) {
  const baseUrl = str(cfg.baseUrl, DEFAULT_BASE).replace(/\/+$/, "");
  const apiKey = str(cfg.apiKey, DEFAULT_KEY);
  const timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchFn = typeof cfg.fetchFn === "function" ? cfg.fetchFn : fetch;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };

  async function request(method, url, { body = null, timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetchFn(url, {
        method,
        headers: body != null ? { ...headers, "Content-Type": "application/json" } : headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      throw new OvError(e?.message ?? String(e), { code: e?.name === "AbortError" ? "TIMEOUT" : null });
    } finally {
      clearTimeout(timer);
    }

    let parsed = null;
    try {
      const text = await res.text();
      if (text) parsed = JSON.parse(text);
    } catch {
      /* non-JSON body is fine for some endpoints */
    }

    const err = classify(res, parsed, method, url);
    if (err) throw err;
    return parsed;
  }

  function q(url, params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      usp.set(k, String(v));
    }
    const s = usp.toString();
    return s ? `${url}?${s}` : url;
  }

  return {
    baseUrl,
    apiKey,
    async write(uri, content, mode = "create", opts = {}) {
      return request("POST", `${baseUrl}/api/v1/content/write`, {
        body: { uri, content, mode, wait: opts.wait !== false },
        timeout: opts.timeout,
      });
    },
    async mkdir(uri, opts = {}) {
      return request("POST", `${baseUrl}/api/v1/fs/mkdir`, {
        body: { uri },
        timeout: opts.timeout,
      });
    },
    async mv(fromUri, toUri, opts = {}) {
      return request("POST", `${baseUrl}/api/v1/fs/mv`, {
        body: { from_uri: fromUri, to_uri: toUri },
        timeout: opts.timeout,
      });
    },
    async rm(uri, { recursive = true, wait = false } = {}) {
      return request("DELETE", q(`${baseUrl}/api/v1/fs`, { uri, recursive, wait }));
    },
    async read(uri, { raw = true } = {}) {
      return request("GET", q(`${baseUrl}/api/v1/content/read`, { uri, raw }));
    },
    async readText(uri) {
      const res = await this.read(uri, { raw: true });
      if (typeof res === "string") return res;
      if (res && typeof res === "object") {
        for (const k of ["result", "content", "text", "data"]) {
          if (typeof res[k] === "string" && res[k].length) return res[k];
        }
      }
      return "";
    },
    async stat(uri) {
      return request("GET", q(`${baseUrl}/api/v1/fs/stat`, { uri }));
    },
    async ls(uri, { simple = true, showAllHidden = false } = {}) {
      return request("GET", q(`${baseUrl}/api/v1/fs/ls`, { uri, simple, show_all_hidden: showAllHidden }));
    },
    async lsResult(uri) {
      const res = await this.ls(uri, { simple: true });
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res?.result)) return res.result;
      return [];
    },
    async grep(uri, pattern) {
      return request("POST", `${baseUrl}/api/v1/search/grep`, {
        body: { uri, pattern },
      });
    },
    async glob(uri, pattern) {
      return request("POST", `${baseUrl}/api/v1/search/glob`, {
        body: { uri, pattern },
      });
    },
    async find(query, { limit = 8, scoreThreshold = 0.15, targetUri = null } = {}) {
      const body = { query, limit, score_threshold: scoreThreshold };
      if (targetUri) body.target_uri = targetUri;
      return request("POST", `${baseUrl}/api/v1/search/find`, { body });
    },
  };
}

/**
 * Normalise a raw read response into { content, fields, ok }.
 * Never throws: on any error returns ok=false with a reason.
 */
export async function readSlot(client, uri) {
  try {
    const text = await client.readText(uri);
    if (!text) return { ok: false, reason: "empty_or_missing" };
    return { ok: true, content: text };
  } catch (e) {
    return { ok: false, reason: e?.code ?? e?.message ?? String(e) };
  }
}
