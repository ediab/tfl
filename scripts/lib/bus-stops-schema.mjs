// Shared strict validation for the generated bus stop index and its
// provenance sidecar. Used by both the generator (self-check before
// publishing) and the standalone validator (scripts/validate-bus-stops.mjs).
//
// Contract (matches the app consumers in app/api/bus-stops/search/route.ts and
// app/api/bus-arrivals/[naptanId]/route.ts, which are unchanged):
//   lib/bus-stops.json       JSON array of { id, name, lat, lon, indicator }
//   lib/bus-stops.meta.json  optional provenance sidecar (new format only;
//                            its absence means provenance is unknown)
//
// Standard Node only; no dependencies.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";

export const META_FORMAT = "tfl-bus-stops-index/1";
export const API_BASE = "https://api.tfl.gov.uk/StopPoint/Mode/bus";
export const API_HOST = "api.tfl.gov.uk";
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_META_BYTES = 8192;
export const MAX_RECORDS = 100_000;
export const MAX_NAME_CHARS = 512;
export const MAX_INDICATOR_CHARS = 512;
export const ID_PATTERN = /^[0-9A-Z]{3,20}$/i;

export function metaPathFor(indexPath) {
  if (!indexPath.endsWith(".json")) return null;
  return indexPath.slice(0, -".json".length) + ".meta.json";
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(code, why) {
  return { ok: false, code, why };
}

// Validates the raw text of a candidate index. Returns the parsed stops on
// success; on failure returns a stable machine code plus a human reason.
export function checkIndexBytes(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad("INDEX-PARSE", "index is not valid JSON");
  }
  if (!Array.isArray(parsed)) return bad("INDEX-ARRAY", "index is not a JSON array");
  if (parsed.length === 0) return bad("INDEX-EMPTY", "index is empty (consumers would silently fall back)");
  if (parsed.length > MAX_RECORDS) return bad("INDEX-OVERSIZE", `index has ${parsed.length} records (cap ${MAX_RECORDS})`);

  const seen = new Set();
  for (let i = 0; i < parsed.length; i++) {
    const s = parsed[i];
    if (!isPlainObject(s)) return bad("INDEX-ENTRY", `record ${i} is not an object`);
    const keys = Object.keys(s).sort().join(",");
    if (keys !== "id,indicator,lat,lon,name") {
      return bad("INDEX-KEYS", `record ${i} keys ${keys} do not match id,indicator,lat,lon,name`);
    }
    if (typeof s.id !== "string" || !ID_PATTERN.test(s.id)) {
      return bad("INDEX-ID", `record ${i} id is not a 3-20 char alphanumeric NaPTAN-style id`);
    }
    if (typeof s.name !== "string" || s.name.length === 0 || s.name.length > MAX_NAME_CHARS) {
      return bad("INDEX-NAME", `record ${i} (${s.id}) name is not a non-empty string within ${MAX_NAME_CHARS} chars`);
    }
    if (typeof s.lat !== "number" || !Number.isFinite(s.lat) || s.lat < -90 || s.lat > 90) {
      return bad("INDEX-LAT", `record ${i} (${s.id}) lat is not a finite number in [-90,90]`);
    }
    if (typeof s.lon !== "number" || !Number.isFinite(s.lon) || s.lon < -180 || s.lon > 180) {
      return bad("INDEX-LON", `record ${i} (${s.id}) lon is not a finite number in [-180,180]`);
    }
    if (typeof s.indicator !== "string" || s.indicator.length > MAX_INDICATOR_CHARS) {
      return bad("INDEX-INDICATOR", `record ${i} (${s.id}) indicator is not a string within ${MAX_INDICATOR_CHARS} chars`);
    }
    if (seen.has(s.id)) return bad("INDEX-DUPLICATE", `record ${i} repeats id ${s.id}`);
    seen.add(s.id);
  }
  return { ok: true, records: parsed.length, stops: parsed };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Validates a parsed sidecar against the measured facts of its index file.
export function checkMetaObject(meta, { bytes, sha256, records }) {
  if (!isPlainObject(meta)) return bad("META-ROOT", "sidecar is not a JSON object");
  if (meta.format !== META_FORMAT) return bad("META-FORMAT", `sidecar format ${JSON.stringify(meta.format)} is not ${META_FORMAT}`);
  if (typeof meta.generator !== "string" || meta.generator.length === 0 || meta.generator.length > 256) {
    return bad("META-GENERATOR", "sidecar generator is not a reasonable string");
  }
  if (typeof meta.generatedAt !== "string" || !ISO_UTC.test(meta.generatedAt) || Number.isNaN(Date.parse(meta.generatedAt))) {
    return bad("META-TIME", "sidecar generatedAt is not an ISO-8601 UTC timestamp");
  }
  if (typeof meta.source !== "string") return bad("META-SOURCE", "sidecar source is not a string");
  let src;
  try {
    src = new URL(meta.source);
  } catch {
    return bad("META-SOURCE", "sidecar source is not a URL");
  }
  // https on the official TfL host, or http on a loopback host (synthetic
  // checks only). Both must be the bus endpoint path with no query (no key).
  const srcOk =
    (src.protocol === "https:" && src.hostname === API_HOST) ||
    (src.protocol === "http:" &&
      (src.hostname === "localhost" || src.hostname.startsWith("127.") || src.hostname === "::1" || src.hostname === "[::1]"));
  if (!srcOk || src.pathname !== "/StopPoint/Mode/bus" || [...src.searchParams.keys()].length > 0) {
    return bad("META-SOURCE", "sidecar source is not the parameter-free TfL bus endpoint (https) or a loopback synthetic base (http)");
  }
  if (typeof meta.keyUsed !== "boolean") return bad("META-KEYUSED", "sidecar keyUsed is not a boolean");
  if (typeof meta.pages !== "number" || !Number.isInteger(meta.pages) || meta.pages < 1 || meta.pages > 50) {
    return bad("META-PAGES", "sidecar pages is not an integer within [1,50]");
  }
  if (typeof meta.records !== "number" || !Number.isInteger(meta.records) || meta.records < 1 || meta.records > MAX_RECORDS || meta.records !== records) {
    return bad("META-RECORDS", "sidecar records does not match the index");
  }
  if (typeof meta.bytes !== "number" || !Number.isInteger(meta.bytes) || meta.bytes < 1 || meta.bytes !== bytes) {
    return bad("META-BYTES", "sidecar bytes does not match the index file size");
  }
  if (typeof meta.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.sha256) || meta.sha256 !== sha256) {
    return bad("META-SHA", "sidecar sha256 does not match the index bytes");
  }
  return { ok: true };
}

// Convenience for file-level checks: hash bytes, guard sizes.
export function sha256OfBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function statRegularWithinCap(path, cap) {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    return { error: e };
  }
  if (!st.isFile()) return { error: new Error("not a regular file") };
  if (st.size < 1) return { error: new Error("empty file") };
  if (st.size > cap) return { error: new Error(`file exceeds ${cap} byte cap`) };
  return { st };
}
