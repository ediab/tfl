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
// Standard Node only; no dependencies. No output here ever includes API
// response values — file paths, enum codes and fixed strings only.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const META_FORMAT = "tfl-bus-stops-index/1";
export const API_BASE = "https://api.tfl.gov.uk/StopPoint/Mode/bus";
export const API_HOST = "api.tfl.gov.uk";
export const BUS_ENDPOINT_PATH = "/StopPoint/Mode/bus";
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_META_BYTES = 8192;
export const MAX_RECORDS = 100_000;
export const MAX_NAME_CHARS = 512;
export const MAX_INDICATOR_CHARS = 512;
export const ID_PATTERN = /^[0-9A-Z]{3,20}$/i;
export const MAX_PAGES = 50;

export function metaPathFor(indexPath) {
  if (!indexPath.endsWith(".json")) return null;
  return indexPath.slice(0, -".json".length) + ".meta.json";
}

// Exact numeric loopback hostnames only: "localhost", the literal IPv4
// loopback range 127.x.y.z (all four octets decimal), or ::1. Substrings
// such as "127.attacker.example" do not match.
export function isLoopbackHostname(hostname) {
  if (hostname === "::1" || hostname === "[::1]") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (m) {
    return m.slice(1).every((o) => Number(o) <= 255);
  }
  return hostname === "localhost";
}

// Classifies a parameter-free source URL for provenance purposes.
// Returns "official" (https on the TfL API host), "synthetic" (http on a
// loopback host, synthetic checks only), or null (not acceptable).
export function classifyProvenanceSource(u) {
  if (u.username !== "" || u.password !== "" || u.hash !== "" || [...u.searchParams.keys()].length > 0) return null;
  if (u.pathname !== BUS_ENDPOINT_PATH) return null;
  if (u.origin === "https://api.tfl.gov.uk") return "official";
  if (u.protocol === "http:" && isLoopbackHostname(u.hostname)) return "synthetic";
  return null;
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(code, why) {
  return { ok: false, code, why };
}

// Validates the raw text of a candidate index. Returns the parsed stops on
// success; on failure returns a stable machine code plus a human reason.
// None of the reasons echo data values of the records.
export function checkIndexBytes(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad("INDEX-PARSE", "index is not valid JSON");
  }
  if (!Array.isArray(parsed)) return bad("INDEX-ARRAY", "index is not a JSON array");
  if (parsed.length === 0) return bad("INDEX-EMPTY", "index is empty (consumers would silently fall back)");
  if (parsed.length > MAX_RECORDS) return bad("INDEX-OVERSIZE", `index has more than ${MAX_RECORDS} records`);

  const seen = new Set();
  for (let i = 0; i < parsed.length; i++) {
    const s = parsed[i];
    if (!isPlainObject(s)) return bad("INDEX-ENTRY", `record ${i} is not an object`);
    const keys = Object.keys(s).sort().join(",");
    if (keys !== "id,indicator,lat,lon,name") {
      return bad("INDEX-KEYS", `record ${i} keys do not match id,indicator,lat,lon,name`);
    }
    if (typeof s.id !== "string" || !ID_PATTERN.test(s.id)) {
      return bad("INDEX-ID", `record ${i} id is not a 3-20 char alphanumeric NaPTAN-style id`);
    }
    if (typeof s.name !== "string" || s.name.length === 0 || s.name.length > MAX_NAME_CHARS) {
      return bad("INDEX-NAME", `record ${i} name is not a non-empty string within ${MAX_NAME_CHARS} chars`);
    }
    if (typeof s.lat !== "number" || !Number.isFinite(s.lat) || s.lat < -90 || s.lat > 90) {
      return bad("INDEX-LAT", `record ${i} lat is not a finite number in [-90,90]`);
    }
    if (typeof s.lon !== "number" || !Number.isFinite(s.lon) || s.lon < -180 || s.lon > 180) {
      return bad("INDEX-LON", `record ${i} lon is not a finite number in [-180,180]`);
    }
    if (typeof s.indicator !== "string" || s.indicator.length > MAX_INDICATOR_CHARS) {
      return bad("INDEX-INDICATOR", `record ${i} indicator is not a string within ${MAX_INDICATOR_CHARS} chars`);
    }
    if (seen.has(s.id)) return bad("INDEX-DUPLICATE", `record ${i} repeats an earlier stop id`);
    seen.add(s.id);
  }
  return { ok: true, records: parsed.length, stops: parsed };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Validates a parsed sidecar against the measured facts of its index file.
// On success the result carries sourceClass: "official" (real TfL endpoint)
// or "synthetic" (loopback fixture) so production gates can tell them apart.
export function checkMetaObject(meta, { bytes, sha256, records }) {
  if (!isPlainObject(meta)) return bad("META-ROOT", "sidecar is not a JSON object");
  if (meta.format !== META_FORMAT) return bad("META-FORMAT", `sidecar format is not ${META_FORMAT}`);
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
  const sourceClass = classifyProvenanceSource(src);
  if (sourceClass === null) {
    return bad("META-SOURCE", "sidecar source is not the parameter-free official TfL endpoint or a parameter-free loopback synthetic base (no userinfo, fragment or query)");
  }
  if (typeof meta.keyUsed !== "boolean") return bad("META-KEYUSED", "sidecar keyUsed is not a boolean");
  if (typeof meta.pages !== "number" || !Number.isInteger(meta.pages) || meta.pages < 1 || meta.pages > MAX_PAGES) {
    return bad("META-PAGES", `sidecar pages is not an integer within [1,${MAX_PAGES}]`);
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
  return { ok: true, sourceClass };
}

// Convenience: hash bytes.
export function sha256OfBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Bounded regular-file read: opens without following symlinks (where the
// platform supports O_NOFOLLOW), checks size/type via fstat on the open fd,
// reads at most cap bytes (rejecting growth/excess) and derives the byte
// count from the actual bytes. Never an unbounded read after a stat.
export function readBoundedFile(path, cap) {
  let flags = constants.O_RDONLY;
  if (constants.O_NOFOLLOW !== undefined) flags |= constants.O_NOFOLLOW;
  if (constants.O_NONBLOCK !== undefined) flags |= constants.O_NONBLOCK;
  let fd;
  try {
    fd = openSync(path, flags);
  } catch (e) {
    return { ok: false, code: "READ-OPEN", why: `cannot open (errno ${e.code ?? "unknown"})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, code: "READ-NOT-REGULAR", why: "not a regular file" };
    if (st.size < 1) return { ok: false, code: "READ-EMPTY", why: "empty file" };
    if (st.size > cap) return { ok: false, code: "READ-OVERSIZE", why: `file exceeds the bounded-read cap (${cap} bytes)` };
    const chunks = [];
    let total = 0;
    for (;;) {
      const want = Math.min(1024 * 1024, cap - total + 1);
      const chunk = Buffer.alloc(want);
      const n = readSync(fd, chunk, 0, want, total);
      if (n === 0) break;
      total += n;
      if (total > cap) return { ok: false, code: "READ-OVERSIZE", why: `file grew past the bounded-read cap (${cap} bytes)` };
      chunks.push(chunk.subarray(0, n));
    }
    if (total !== st.size) {
      return { ok: false, code: "READ-SIZE-CHANGED", why: `file changed between stat and read (fstat says ${st.size} bytes, read saw ${total})` };
    }
    return { ok: true, bytes: total, buf: total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total) };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}
