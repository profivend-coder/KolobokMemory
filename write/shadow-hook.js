// selective-memory — STAGE 5.5 write/shadow-hook.js
//
// SHADOW HOOK for agent_end.
//
// Purpose: run the Smart Memory Write decision pipeline over a completed
// real OpenClaw turn, WITHOUT any physical write. The writer is NEVER imported
// or executed here. write.enabled=false is enforced structurally: this module
// has no reference to write/writer.js.
//
// Fail model (STAGE 5.5 spec):
//   - fail-open  for the conversation: any error → turn is unaffected, we just
//     return null (the agent_end hook has already completed user delivery).
//   - fail-closed for memory: any error → we emit a SKIP (never a WOULD_* that
//     could later be misread as a positive signal).
//
// Pipeline (mirrors write/index.js but adds an explicit timeout + no-write
// guarantee):
//   agent_end turn text
//     → sanitise (secret filter)          [write/secret-filter.js]
//     → candidate extraction              [write/extract.js]
//     → write gate                        [write/gate.js]
//     → dedup lookup (read-only find)     [write/lookup.js + write/dedup.js]
//     → conflict resolver                 [write/conflict.js]
//     → audit trace                       [write/trace.js]
//
// Only WOULD_* / SKIP_* appear in the output. No WRITE_NEW/UPDATE/SUPERSEDE
// mutation is ever issued, and writer.execute is never invoked.

import { runDecisionPipeline } from "./index.js";
import { serializeTrace } from "./trace.js";

// Default shadow timeout: the hook must not drag the turn; 1500ms is enough for
// a small number of read-only find calls against a local OpenViking and is far
// under the runner's 30s agent_end budget.
const DEFAULT_SHADOW_TIMEOUT_MS = 1500;

/**
 * Extract a best-effort turn text from an agent_end event.
 * The event may expose `messages` (final session messages) and/or a prompt.
 * We only take user-authored (not synthetic) and assistant text so the shadow
 * pipeline sees the same material a real write stage would.
 *
 * We deliberately do NOT persist secrets: the secret-filter runs first inside
 * the pipeline and the trace records secret TYPES only.
 */
export function turnTextFromEvent(event) {
  const parts = [];
  const msgs = Array.isArray(event?.messages) ? event.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const role = typeof m.role === "string" ? m.role : "";
    // Only user and assistant authored text is evaluable; skip system/tool.
    if (role !== "user" && role !== "assistant") continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      const blocks = [];
      for (const b of m.content) {
        if (!b || typeof b !== "object") continue;
        if (typeof b.text === "string" && b.text) blocks.push(b.text);
        else if (typeof b.content === "string" && b.content) blocks.push(b.content);
      }
      text = blocks.join("\n");
    }
    if (typeof m.text === "string" && m.text) text = m.text;
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join("\n");
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: "shadow_timeout", timedOut: true });
    }, ms);
    promise
      .then((v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value: v });
      })
      .catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: e?.message ?? String(e) });
      });
  });
}

/**
 * Run the write shadow pipeline for a turn.
 *
 * @param {object} writeCfg  { enabled:false, shadow:true, ... } writer flags
 * @param {object} ovCfg     OpenViking connection (baseUrl/apiKey/recallLimit/...)
 * @param {{turnId?: string, text?: string, timestamp?: string}} turn
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok:boolean, serialized:string|null, result:object|null,
 *                    error:string|null}>}
 *   `ok:false` is ALWAYS fail-closed for memory (no WOULD_* emitted).
 */
export async function runWriteShadow(writeCfg, ovCfg, turn, opts = {}) {
  const timeoutMs =
    typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_SHADOW_TIMEOUT_MS;

  // Hard fail-closed: if write is (mis)configured to enabled, refuse to run.
  if (writeCfg && writeCfg.enabled === true) {
    return { ok: false, serialized: null, result: null, error: "shadow_refused:write_enabled" };
  }

  const text = typeof turn?.text === "string" ? turn.text : "";
  if (!text.trim()) {
    return { ok: true, serialized: null, result: { shadow: true, turnId: turn?.turnId ?? null, candidates: [], decisions: [], trace: [] }, error: null };
  }

  // Read-only lookup build (may throw → handled below, fail-closed).
  let lookup = null;
  try {
    const { createLookup } = await import("./lookup.js");
    lookup = createLookup(ovCfg);
  } catch {
    lookup = null; // fail-closed: no lookup → pipeline yields AMBIGUOUS → SKIP
  }

  const run = runDecisionPipeline({ ...writeCfg, enabled: false, shadow: true }, turn, lookup);
  const wrapped = await withTimeout(run, timeoutMs);

  if (!wrapped.ok) {
    // Fail-closed for memory: emit an explicit SKIP trace, never a WOULD_*.
    return { ok: false, serialized: null, result: null, error: wrapped.error ?? "shadow_failed" };
  }

  const result = wrapped.value;
  return {
    ok: true,
    serialized: serializeTrace(result?.trace ?? []),
    result,
    error: null,
  };
}

export { serializeTrace };