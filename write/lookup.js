// selective-memory — STAGE 5.2 write/lookup.js
//
// READ-ONLY OpenViking lookup for dedup. Reuses the production read-path
// `openvikingFind` (which already applies the .overview.md / .abstract.md
// sidecar filter from STAGE 4.4) — no write endpoint is ever touched.
//
// Two queries per candidate:
//   valueQuery    → "entity property value"   (detect the same fact)
//   propertyQuery → "entity property"          (detect the same slot, any value)
//
// `createLookup(ovCfg)` returns an async `lookup(candidate)` used by the
// shadow pipeline. Tests inject their own lookup, so this module has no
// network dependency in the test suite.

import { openvikingFind } from "../index.js";

export function valueQuery(candidate) {
  return [candidate?.entity, candidate?.property, candidate?.value]
    .filter((x) => typeof x === "string" && x.trim())
    .join(" ");
}

export function propertyQuery(candidate) {
  return [candidate?.entity, candidate?.property]
    .filter((x) => typeof x === "string" && x.trim())
    .join(" ");
}

/**
 * Build a read-only lookup function bound to an OpenViking connection config
 * (the same shape the read-path `index.js` uses: openvikingBaseUrl,
 * openvikingApiKey, openvikingTargetUri, recallLimit, recallScoreThreshold,
 * timeoutMs).
 *
 * @param {object} ovCfg
 * @returns {(candidate: object) => Promise<{byValue: object, byProperty: object}>}
 */
export function createLookup(ovCfg) {
  async function find(query) {
    if (!query) return { ok: true, error: null, memories: [] };
    try {
      const memories = await openvikingFind(ovCfg, query);
      return { ok: true, error: null, memories };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e), memories: [] };
    }
  }

  return async function lookup(candidate) {
    const [byValue, byProperty] = await Promise.all([
      find(valueQuery(candidate)),
      find(propertyQuery(candidate)),
    ]);
    return { byValue, byProperty };
  };
}
