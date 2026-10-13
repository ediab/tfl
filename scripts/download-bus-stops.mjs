#!/usr/bin/env node
// Regenerates lib/bus-stops.json from the TfL Unified API.
//
// Usage:
//   TFL_API_KEY=xxx node scripts/download-bus-stops.mjs
//   node scripts/download-bus-stops.mjs            (keyless where TfL allows it)
//
// Bounds every run with FIXED caps: one redirect per request, a whole-run
// deadline plus a per-page deadline that spans the complete body consumption
// (a stalled body after headers expires, never hangs), per-page and total
// byte caps, and complete strict paging validation. Caps are enforced early:
// a declared total above the record cap is refused before any collection,
// every stop is fully validated before storage, and the cumulative
// serialized byte size is bounded while streaming pages.
//
// Secrets: app_key travels only in the API request URL. Errors and logs
// never echo the URL, headers, body or ANY API response value — only status
// codes, our own page/position numbers and stable fixed strings — so a
// hostile response cannot reflect the key into the output.
//
// Publication: index bytes are fully validated and the sidecar is fully
// validated BEFORE the previous index is changed; publication then commits
// the index atomically (unique owned temp file, fsync, rename) and
// the sidecar after it, followed by a fail-closed pair readback. Failures
// before the index commit leave the previous good index untouched; a
// failure after the index commit is reported honestly as an incomplete pair.

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, pid } from "node:process";
import {
  API_BASE,
  checkIndexBytes,
  checkMetaObject,
  classifyProvenanceSource,
  ID_PATTERN,
  MAX_INDEX_BYTES,
  MAX_INDICATOR_CHARS,
  MAX_META_BYTES,
  MAX_NAME_CHARS,
  MAX_PAGES,
  MAX_RECORDS,
  META_FORMAT,
  metaPathFor,
  readBoundedFile,
  sha256OfBytes,
} from "./lib/bus-stops-schema.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = join(__dir, "../lib/bus-stops.json");
const META_FILE = metaPathFor(INDEX_FILE);

// ---- Fixed contract bounds (audit this file, not a config) ----
const MAX_REDIRECTS = 1;
const MAX_ATTEMPTS_PER_PAGE = 2;
const INTERPAGE_PAUSE_MS_DEFAULT = 250;
const RETRY_PAUSE_MS = 1_000;
const PAGE_TIMEOUT_MS_DEFAULT = 10_000;
const PAGE_TIMEOUT_MS_MAX = 300_000;
const RUN_DEADLINE_MS_DEFAULT = 600_000;
const RUN_DEADLINE_MS_MAX = 1_800_000;
const MAX_PAGE_BYTES_DEFAULT = 32 * 1024 * 1024;

const log = (msg) => writeSync(2, msg + "\n");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function failExit(code, why) {
  log(`ERROR ${code}: ${why}`);
  exit(1);
}

// Strict config parsing: present-and-invalid (zero, negative, garbage,
// above the clamp) exits with CONFIG-BAD naming the variable — no values.
function parseEnvIntStrict(name, { min, max, otherwise }) {
  const raw = process.env[name];
  if (raw === undefined) return otherwise;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || `${n}` !== raw.trim() || n < min || n > max) {
    failExit("CONFIG-BAD", `${name} must be an integer in [${min},${max}]`);
  }
  return n;
}

const PAGE_TIMEOUT_MS = parseEnvIntStrict("TFL_STOPS_TIMEOUT_MS", { min: 1, max: PAGE_TIMEOUT_MS_MAX, otherwise: PAGE_TIMEOUT_MS_DEFAULT });
const RUN_DEADLINE_MS = parseEnvIntStrict("TFL_STOPS_TOTAL_MS", { min: 1, max: RUN_DEADLINE_MS_MAX, otherwise: RUN_DEADLINE_MS_DEFAULT });
const INTERPAGE_MS = parseEnvIntStrict("TFL_STOPS_PAUSE_MS", { min: 0, max: 60_000, otherwise: INTERPAGE_PAUSE_MS_DEFAULT });
const MAX_PAGE_BYTES = parseEnvIntStrict("TFL_STOPS_MAX_PAGE_BYTES", { min: 1, max: MAX_INDEX_BYTES, otherwise: MAX_PAGE_BYTES_DEFAULT });

const isTransient = (code) =>
  code === "FETCH-NET" ||
  code === "FETCH-HTTP-TIMEOUT" ||
  code.startsWith("FETCH-HTTP-STATUS-5");

// Test-only endpoint override: the official https TfL endpoint, or an http
// URL on an exact loopback host (synthetic checks). Userinfo, fragments and
// query parameters (e.g. an app_key) are rejected.
function resolveBase() {
  const base = process.env.TFL_STOPS_BASE_URL ?? API_BASE;
  let u;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  const sourceClass = classifyProvenanceSource(u);
  return (base === API_BASE && sourceClass === "official") || sourceClass === "synthetic" ? u : null;
}

async function releaseBody(res) {
  try {
    if (res && res.body) await res.body.cancel();
  } catch {}
}

// ---- Bounded GET returning parsed JSON. The single page deadline (one
// AbortController timer) spans redirects, headers AND the complete body
// read, so a server that stalls after sending headers expires the deadline
// instead of hanging. Response bodies are released/cancelled on every exit
// path (redirect, non-2xx, oversize, error, completion).
async function fetchJsonBounded(urlString, apiOrigin, apiProtocol, runDeadline) {
  const ac = new AbortController();
  let aborted = false;
  let reader;
  const remaining = runDeadline - performance.now();
  if (remaining <= 0) return { error: true, code: "FETCH-RUN-DEADLINE", why: "whole-run deadline exhausted" };
  const runLimited = remaining <= PAGE_TIMEOUT_MS;
  const timeoutError = () => ({ error: true, code: runLimited ? "FETCH-RUN-DEADLINE" : "FETCH-HTTP-TIMEOUT", why: "request did not complete within its deadline" });
  const timer = setTimeout(() => {
    aborted = true;
    ac.abort();
  }, Math.min(PAGE_TIMEOUT_MS, remaining));
  try {
    let url = urlString;
    let redirects = 0;
    for (;;) {
      const parsed = new URL(url); // only we build URLs; always absolute
      if (parsed.origin !== apiOrigin || parsed.protocol !== apiProtocol) {
        return { error: true, code: "FETCH-URL-BAD", why: "refusing endpoint other than the configured base" };
      }
      let res;
      try {
        res = await fetch(parsed, { redirect: "manual", signal: ac.signal, headers: { Accept: "application/json", "User-Agent": "tfl-native-rollout-contract-check/1" } });
      } catch (e) {
        if (aborted || e?.name === "AbortError") {
          return timeoutError();
        }
        return { error: true, code: e?.cause?.code ?? "FETCH-NET", why: "network error" };
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        await releaseBody(res);
        if (!loc) return { error: true, code: "FETCH-REDIRECT-NOLOC", why: "redirect without location" };
        if (redirects >= MAX_REDIRECTS) {
          return { error: true, code: "FETCH-REDIRECTS", why: `more than ${MAX_REDIRECTS} redirect is not followed` };
        }
        redirects++;
        url = new URL(loc, parsed).toString();
        continue;
      }
      if (!res.ok) {
        // Status code only: never the URL (it carries app_key), headers or body.
        const status = res.status;
        await releaseBody(res);
        return { error: true, code: `FETCH-HTTP-STATUS-${status}`, why: "API answered a non-2xx status" };
      }
      const declared = res.headers.get("content-length");
      if (declared && Number(declared) > MAX_PAGE_BYTES) {
        await releaseBody(res);
        return { error: true, code: "FETCH-OVERSIZE-HEADER", why: "declared body exceeds the per-page cap" };
      }
      if (!res.body) {
        return { error: true, code: "FETCH-BODY-NONE", why: "response has no body" };
      }
      reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "";
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_PAGE_BYTES) {
            return { error: true, code: "FETCH-OVERSIZE-BODY", why: "body exceeded the per-page cap" };
          }
          try {
            text += decoder.decode(value, { stream: true });
          } catch {
            return { error: true, code: "FETCH-ENCODING-BAD", why: "body is not valid UTF-8" };
          }
        }
      } catch {
        // Streamed body failed (connection cut, abort): stable, value-free.
        await reader.cancel().catch(() => {});
        if (aborted) {
          return timeoutError();
        }
        return { error: true, code: "FETCH-BODY-READ", why: "response body consumption failed" };
      }
      try {
        text += decoder.decode();
      } catch {
        return { error: true, code: "FETCH-ENCODING-BAD", why: "body is not valid UTF-8" };
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { error: true, code: "FETCH-PARSE", why: "body is truncated or not valid JSON" };
      }
      return { error: false, data, bytes: received };
    }
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
    clearTimeout(timer);
  }
}

// Validates one page envelope. Strict, with stable value-free reasons:
// missing/mistyped metadata, zero/negative pageSize, wrong page,
// mid-run inconsistent totals or a declared total above the record cap are
// fatal. Completeness is proven from counts, never assumed.
function validateEnvelope(data, page, firstTotal, firstPageSize) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { error: true, code: "PAGING-ROOT-BAD", why: "response is not a JSON object" };
  }
  if (!Array.isArray(data.stopPoints)) {
    return { error: true, code: "PAGING-STOPPOINTS-BAD", why: "stopPoints array missing" };
  }
  if (typeof data.total !== "number" || !Number.isInteger(data.total) || data.total < 1) {
    return { error: true, code: "PAGING-TOTAL-BAD", why: "total missing or not a positive integer" };
  }
  if (typeof data.pageSize !== "number" || !Number.isInteger(data.pageSize) || data.pageSize < 1) {
    return { error: true, code: "PAGING-PAGESIZE-BAD", why: "pageSize missing or not a positive integer" };
  }
  if (data.page !== page) {
    return { error: true, code: "PAGING-PAGE-BAD", why: "page does not match the requested page" };
  }
  if (firstTotal !== null && data.total !== firstTotal) {
    return { error: true, code: "PAGING-INCONSISTENT", why: "total changed across pages" };
  }
  if (firstPageSize !== null && data.pageSize !== firstPageSize) {
    return { error: true, code: "PAGING-INCONSISTENT", why: "pageSize changed across pages" };
  }
  return { error: false, stopPoints: data.stopPoints, total: data.total, pageSize: data.pageSize };
}

// Type-shape only; field limits and the id pattern are enforced before
// storage (see below) so every rejection can cite page and position.
function normalizeStop(s) {
  if (typeof s !== "object" || s === null || Array.isArray(s)) return null;
  if (typeof s.naptanId !== "string" || s.naptanId.length === 0) return null;
  if (typeof s.commonName !== "string" || s.commonName.length === 0) return null;
  if (typeof s.lat !== "number" || !Number.isFinite(s.lat)) return null;
  if (typeof s.lon !== "number" || !Number.isFinite(s.lon)) return null;
  return {
    id: s.naptanId,
    name: s.commonName,
    lat: s.lat,
    lon: s.lon,
    indicator: typeof s.indicator === "string" ? s.indicator : "",
  };
}

function stopWithinLimits(st) {
  if (!ID_PATTERN.test(st.id)) return false;
  if (st.name.length > MAX_NAME_CHARS) return false;
  if (st.indicator.length > MAX_INDICATOR_CHARS) return false;
  if (st.lat < -90 || st.lat > 90) return false;
  if (st.lon < -180 || st.lon > 180) return false;
  return true;
}

// Unique owned staging file: `wx` creation of a per-run name. Nothing
// pre-existing is ever deleted — concurrent or dead runs' files are left
// alone, only this run's own temp is unlinked on error.
function publishAtomic(path, text) {
  const tmp = `${path}.tmp-${pid}-${randomBytes(6).toString("hex")}`;
  let fd;
  try {
    fd = openSync(tmp, "wx");
    fchmodSync(fd, 0o644);
    const bytes = Buffer.from(text, "utf8");
    let wrote = 0;
    while (wrote < bytes.length) {
      wrote += writeSync(fd, bytes, wrote, bytes.length - wrote);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== undefined && fd >= 0) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmp); } catch {}
    return { error: true, code: "ATOMIC-" + (e.code ?? "FAIL"), why: "publication staging failed" };
  }
  try {
    const dir = openSync(dirname(path), "r");
    fsyncSync(dir);
    closeSync(dir);
  } catch {}
  return { error: false };
}

async function main() {
  if (process.argv.length > 2) {
    failExit("USAGE-FLAGS", "this generator takes no arguments; configure via TFL_API_KEY / TFL_STOPS_* env");
  }
  const runDeadline = performance.now() + RUN_DEADLINE_MS;
  function checkRunDeadline() {
    if (performance.now() >= runDeadline) failExit("FETCH-RUN-DEADLINE", "whole-run deadline exhausted");
  }
  async function boundedPause(ms) {
    checkRunDeadline();
    await pause(Math.min(ms, runDeadline - performance.now()));
    checkRunDeadline();
  }
  const apiBase = resolveBase();
  if (!apiBase) {
    failExit("BASE-BAD", "endpoint must be the official TfL https URL or a parameter-free exact-loopback http URL (no userinfo, fragment or query) for synthetic checks");
  }
  if (apiBase.toString() !== API_BASE) log(`synthetic base override in effect: ${apiBase.origin}${apiBase.pathname} (test-only)`);
  const apiKey = process.env.TFL_API_KEY ?? "";
  log(apiKey ? "running with a TfL app_key (never logged or written)" : "running keyless (supported where TfL allows it)");

  const stops = [];
  const seenIds = new Set();
  let firstTotal = null;
  let firstPageSize = null;
  let expectedPages = null;
  let pagesFetched = 0;
  let runningBytes = 0; // exact serialized byte cost of stored stops (without brackets/commas)

  for (let page = 1; ; page++) {
    checkRunDeadline();
    const url = new URL(apiBase);
    url.searchParams.set("page", String(page));
    if (apiKey) url.searchParams.set("app_key", apiKey);

    let res = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
      log(`page ${page} attempt ${attempt}/${MAX_ATTEMPTS_PER_PAGE}...`);
      checkRunDeadline();
      res = await fetchJsonBounded(url.toString(), apiBase.origin, apiBase.protocol, runDeadline);
      checkRunDeadline();
      if (!res.error) break;
      if (!isTransient(res.code) || attempt === MAX_ATTEMPTS_PER_PAGE) {
        failExit(res.code, res.why);
      }
      log(`transient ${res.code}; retrying in ${RETRY_PAUSE_MS}ms`);
      await boundedPause(RETRY_PAUSE_MS);
    }

    const env2 = validateEnvelope(res.data, page, firstTotal, firstPageSize);
    if (env2.error) failExit(env2.code, `${env2.why} (page ${page})`);
    if (firstTotal === null) {
      // Cap refused BEFORE any collection begins.
      if (env2.total > MAX_RECORDS) {
        failExit("PAGING-OVERSIZE-DECLARED", `declared total exceeds the record cap (${MAX_RECORDS})`);
      }
      firstTotal = env2.total;
      firstPageSize = env2.pageSize;
      expectedPages = Math.ceil(firstTotal / firstPageSize);
      if (expectedPages > MAX_PAGES) {
        failExit("PAGING-TOO-MANY-PAGES", `declared paging requires more than ${MAX_PAGES} pages`);
      }
      log(`declared total ${firstTotal}, pageSize ${firstPageSize}, expected pages ${expectedPages}`);
    }

    const isLast = page === expectedPages;
    const expectedCount = isLast ? firstTotal - (expectedPages - 1) * firstPageSize : firstPageSize;
    if (env2.stopPoints.length !== expectedCount) {
      failExit("PAGING-PAGE-COUNT", `page ${page} returned a stop count that does not match the paging math for its position`);
    }

    for (let i = 0; i < env2.stopPoints.length; i++) {
      checkRunDeadline();
      const st = normalizeStop(env2.stopPoints[i]);
      if (!st) {
        failExit("PAGING-STOP-BAD", `malformed stop entry at page ${page} position ${i}`);
      }
      // Full field limits and id pattern before storage.
      if (!stopWithinLimits(st)) {
        failExit("PAGING-STOP-LIMITS", `stop entry exceeds field limits at page ${page} position ${i}`);
      }
      if (seenIds.has(st.id)) {
        failExit("PAGING-DUPLICATE", `stop repeated an already-collected id at page ${page} position ${i}`);
      }
      // Cumulative serialized bound, enforced before pushing.
      const stopBytes = Buffer.byteLength(JSON.stringify(st), "utf8");
      const prospective = runningBytes + stopBytes + stops.length + 1 + 1; // + commas + 2 brackets
      if (stops.length + 1 > MAX_RECORDS || prospective > MAX_INDEX_BYTES) {
        failExit("PAGING-OVERSIZE-INDEX", "collected stops would exceed the record or byte cap");
      }
      seenIds.add(st.id);
      stops.push(st);
      runningBytes += stopBytes;
    }
    pagesFetched = page;
    log(`page ${page}: ${env2.stopPoints.length} stops, cumulative ${stops.length}`);

    if (isLast) break;
    await boundedPause(INTERPAGE_MS);
  }

  if (stops.length !== firstTotal) {
    failExit("PAGING-INCOMPLETE", "collected stop count does not match the declared total");
  }

  const collator = new Intl.Collator("en", { sensitivity: "base" });
  stops.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const indexText = JSON.stringify(stops);
  checkRunDeadline();
  // All pre-commit validation happens BEFORE the previous index is changed.
  const check = checkIndexBytes(indexText);
  if (!check.ok) failExit("GENERATED-BAD", `generated index failed self-check ${check.code}`);
  const indexBytes = Buffer.byteLength(indexText, "utf8");
  const indexSha = sha256OfBytes(Buffer.from(indexText, "utf8"));

  const meta = {
    format: META_FORMAT,
    generator: "scripts/download-bus-stops.mjs",
    generatedAt: new Date().toISOString(),
    source: apiBase.origin + apiBase.pathname,
    keyUsed: apiKey !== "",
    pages: pagesFetched,
    records: stops.length,
    bytes: indexBytes,
    sha256: indexSha,
  };
  const metaText = JSON.stringify(meta, null, 2) + "\n";
  const metaCheck = checkMetaObject(meta, { bytes: indexBytes, sha256: indexSha, records: stops.length });
  if (!metaCheck.ok) failExit("META-INTERNAL", `sidecar failed self-check ${metaCheck.code}`);

  // Commit 1: the index. Failures up to and including this point left the
  // previous good index untouched (atomic rename is the commit point).
  checkRunDeadline();
  const pub = publishAtomic(INDEX_FILE, indexText);
  if (pub.error) failExit(pub.code, `index publication failed: ${pub.why}`);

  // Commit 2: the sidecar. A failure here is an honest PAIR-INCOMPLETE: the
  // new index is committed, its provenance is missing (or a previous stale
  // sidecar remains and will fail matching until a clean rerun fixes it).
  const pubMeta = publishAtomic(META_FILE, metaText);
  if (pubMeta.error) {
    failExit("PAIR-INCOMPLETE", "index committed but sidecar publication failed; the index is present while provenance is missing or stale");
  }

  // Fail-closed pair readback from disk: published bytes and sidecar must
  // reproduce exactly the validated facts, or the publication is refused.
  const rbIndex = readBoundedFile(INDEX_FILE, MAX_INDEX_BYTES);
  if (!rbIndex.ok || rbIndex.bytes !== indexBytes || sha256OfBytes(rbIndex.buf) !== indexSha) {
    failExit("PAIR-MISMATCH", "published index bytes do not match the validated bytes (fail closed)");
  }
  const rbMeta = readBoundedFile(META_FILE, MAX_META_BYTES);
  if (!rbMeta.ok) failExit("PAIR-MISMATCH", "published sidecar is not readable (fail closed)");
  let rbMetaObj;
  try {
    rbMetaObj = JSON.parse(rbMeta.buf.toString("utf8"));
  } catch {
    failExit("PAIR-MISMATCH", "published sidecar is not valid JSON (fail closed)");
  }
  const rbMetaCheck = checkMetaObject(rbMetaObj, { bytes: indexBytes, sha256: indexSha, records: stops.length });
  if (!rbMetaCheck.ok || rbMetaCheck.sourceClass === undefined) {
    failExit("PAIR-MISMATCH", "published sidecar does not match the published index (fail closed)");
  }

  log(`wrote ${relative(process.cwd(), INDEX_FILE)} (${indexBytes} bytes, sha256 ${indexSha.slice(0, 12)}..., ${stops.length} stops, ${pagesFetched} pages)`);
  log(`wrote provenance sidecar ${relative(process.cwd(), META_FILE)}`);
  log("OK: bus stop index and provenance sidecar published as a consistent pair");
}

main().catch((e) => {
  log(`ERROR INTERNAL: unexpected failure: ${e?.message ?? e}`);
  exit(1);
});
