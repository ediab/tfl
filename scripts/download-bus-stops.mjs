#!/usr/bin/env node
// Regenerates lib/bus-stops.json from the TfL Unified API.
//
// Usage:
//   TFL_API_KEY=xxx node scripts/download-bus-stops.mjs
//   node scripts/download-bus-stops.mjs            (keyless where TfL allows it)
//
// Bounds every run: capped redirects/hops, body sizes, timeouts and page
// counts; strict response-shape and complete-paging validation (absent or
// malformed paging metadata is an error, never silent completion); duplicate
// stop ids are fatal; errors never echo the app_key or request URL; and
// publication is atomic (fsync + rename) with a small provenance sidecar
// (lib/bus-stops.meta.json) written only after the index commit. Any failure
// exits 1 and leaves a previous good index untouched.

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { env, exit } from "node:process";
import {
  API_BASE,
  checkIndexBytes,
  checkMetaObject,
  MAX_INDEX_BYTES,
  META_FORMAT,
  sha256OfBytes,
} from "./lib/bus-stops-schema.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = join(__dir, "../lib/bus-stops.json");

// ---- Contract bounds (fixed constants; audit this file, not a config) ----
const MAX_PAGES = 50;
const MAX_REDIRECTS = 1;
const MAX_ATTEMPTS_PER_PAGE = 2;
const INTERPAGE_PAUSE_MS = 250;
const RETRY_PAUSE_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGE_BYTES = 32 * 1024 * 1024;

// Test-only endpoint override: the official https TfL endpoint, or an http
// URL on a loopback host (synthetic checks). No query parameters allowed.
function resolveBase() {
  const base = env.TFL_STOPS_BASE_URL ?? API_BASE;
  let u;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  if ([...u.searchParams.keys()].length > 0) return null;
  const loopback = u.hostname === "localhost" || u.hostname.startsWith("127.") || u.hostname === "::1" || u.hostname === "[::1]";
  if (u.protocol === "https:" && base === API_BASE) return u;
  if (u.protocol === "http:" && loopback) return u;
  return null;
}

const TMP_SUFFIX = ".tmp-atomic";
const log = (msg) => writeSync(2, msg + "\n");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function failExit(code, why) {
  log(`ERROR ${code}: ${why}`);
  exit(1);
}

function parseEnvMs(name, fallback) {
  const n = Number.parseInt(env[name] ?? "", 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 300_000);
}

function parseEnvBytes(name, fallback) {
  const n = Number.parseInt(env[name] ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_INDEX_BYTES);
}

const REQUEST_TIMEOUT_MS = parseEnvMs("TFL_STOPS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
const INTERPAGE_MS = parseEnvMs("TFL_STOPS_PAUSE_MS", INTERPAGE_PAUSE_MS);
const MAX_PAGE_BYTES = parseEnvBytes("TFL_STOPS_MAX_PAGE_BYTES", DEFAULT_MAX_PAGE_BYTES);

const isTransient = (code) =>
  code === "FETCH-NET" ||
  code === "FETCH-HTTP-TIMEOUT" ||
  code.startsWith("FETCH-HTTP-STATUS-5");

// ---- Bounded HTTPS GET returning parsed JSON (standard fetch, manual
// redirects so the app_key query is never re-sent cross-origin) ----
async function fetchJsonBounded(urlString, apiOrigin, apiProtocol) {
  let url = urlString;
  let redirects = 0;
  for (;;) {
    const parsed = new URL(url); // only we build URLs; always absolute
    if (parsed.origin !== apiOrigin || parsed.protocol !== apiProtocol) {
      return { error: true, code: "FETCH-URL-BAD", why: "refusing endpoint other than the configured base" };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(parsed, { redirect: "manual", signal: ac.signal });
    } catch (e) {
      clearTimeout(timer);
      if (e?.name === "AbortError") {
        return { error: true, code: "FETCH-HTTP-TIMEOUT", why: `no response within ${REQUEST_TIMEOUT_MS}ms` };
      }
      return { error: true, code: e?.cause?.code ?? "FETCH-NET", why: "network error" };
    }
    clearTimeout(timer);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return { error: true, code: "FETCH-REDIRECT-NOLOC", why: "redirect without location" };
      if (redirects >= MAX_REDIRECTS) {
        return { error: true, code: "FETCH-REDIRECTS", why: `more than ${MAX_REDIRECTS} redirect is not followed` };
      }
      redirects++;
      url = new URL(loc, parsed).toString();
      continue;
    }
    if (!res.ok) {
      // Status only: never the URL (it carries app_key) and never the body.
      return { error: true, code: `FETCH-HTTP-STATUS-${res.status}`, why: `API answered ${res.status}` };
    }
    const declared = res.headers.get("content-length");
    if (declared && Number(declared) > MAX_PAGE_BYTES) {
      return { error: true, code: "FETCH-OVERSIZE-HEADER", why: `declared body exceeds ${MAX_PAGE_BYTES} bytes` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_PAGE_BYTES) {
        await reader.cancel().catch(() => {});
        return { error: true, code: "FETCH-OVERSIZE-BODY", why: `body exceeded ${MAX_PAGE_BYTES} bytes` };
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        await reader.cancel().catch(() => {});
        return { error: true, code: "FETCH-ENCODING-BAD", why: "body is not valid UTF-8" };
      }
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
}

// Validates one page envelope. Paging metadata is required and strict:
// absent, mistyped, zero/negative pageSize, stale currentPage or totals that
// change mid-run all fail. Completeness is proven from counts, never assumed.
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
  if (data.currentPage !== page) {
    return { error: true, code: "PAGING-CURRENTPAGE-BAD", why: `currentPage ${JSON.stringify(data.currentPage)} is not the requested page ${page}` };
  }
  if (firstTotal !== null && data.total !== firstTotal) {
    return { error: true, code: "PAGING-INCONSISTENT", why: `total changed mid-run (${firstTotal} -> ${data.total})` };
  }
  if (firstPageSize !== null && data.pageSize !== firstPageSize) {
    return { error: true, code: "PAGING-INCONSISTENT", why: `pageSize changed mid-run (${firstPageSize} -> ${data.pageSize})` };
  }
  return { error: false, stopPoints: data.stopPoints, total: data.total, pageSize: data.pageSize };
}

function normalizeStop(s, page, position) {
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

// One atomic fsync+rename publication; "wx" refuses concurrent clobbering.
function publishAtomic(path, text, mode) {
  const tmp = path + TMP_SUFFIX;
  try {
    unlinkSync(tmp);
  } catch {}
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
    return { error: true, code: "ATOMIC-" + (e.code ?? "FAIL"), why: e.message };
  }
  try {
    const dir = openSync(dirname(path), "r");
    fsyncSync(dir);
    closeSync(dir);
  } catch {}
  return { error: false };
}

// Removes dead-run temporaries so a rerun is never blocked by stale files.
function clearStaleTmp() {
  for (const p of [INDEX_FILE + TMP_SUFFIX, INDEX_FILE.replace(/\.json$/, ".meta.json") + TMP_SUFFIX]) {
    try {
      unlinkSync(p);
    } catch {}
  }
}

async function main() {
  if (process.argv.length > 2) {
    failExit("USAGE-FLAGS", "this generator takes no arguments; configure via TFL_API_KEY / TFL_STOPS_* env");
  }
  const apiBase = resolveBase();
  if (!apiBase) {
    failExit("BASE-BAD", "endpoint must be the official TfL https URL or a parameter-free loopback http URL for synthetic checks");
  }
  if (apiBase.toString() !== API_BASE) log(`synthetic base override in effect: ${apiBase.origin}${apiBase.pathname} (test-only)`);
  const apiKey = env.TFL_API_KEY ?? "";
  log(apiKey ? "running with a TfL app_key (never logged or written)" : "running keyless (supported where TfL allows it)");
  clearStaleTmp();

  const stops = [];
  const seenIds = new Set();
  let firstTotal = null;
  let firstPageSize = null;
  let expectedPages = null;
  let pagesFetched = 0;

  for (let page = 1; ; page++) {
    const url = new URL(apiBase);
    url.searchParams.set("page", String(page));
    if (apiKey) url.searchParams.set("app_key", apiKey);

    let res = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
      log(`page ${page} attempt ${attempt}/${MAX_ATTEMPTS_PER_PAGE}...`);
      res = await fetchJsonBounded(url.toString(), apiBase.origin, apiBase.protocol);
      if (!res.error) break;
      if (!isTransient(res.code) || attempt === MAX_ATTEMPTS_PER_PAGE) {
        failExit(res.code, res.why);
      }
      log(`transient ${res.code}; retrying in ${RETRY_PAUSE_MS}ms`);
      await pause(RETRY_PAUSE_MS);
    }

    const env2 = validateEnvelope(res.data, page, firstTotal, firstPageSize);
    if (env2.error) failExit(env2.code, `${env2.why} (page ${page})`);
    if (firstTotal === null) {
      firstTotal = env2.total;
      firstPageSize = env2.pageSize;
      expectedPages = Math.ceil(firstTotal / firstPageSize);
      if (expectedPages > MAX_PAGES) {
        failExit("PAGING-TOO-MANY-PAGES", `declared paging requires ${expectedPages} pages (cap ${MAX_PAGES})`);
      }
      log(`declared total ${firstTotal}, pageSize ${firstPageSize}, expected pages ${expectedPages}`);
    }

    const isLast = page === expectedPages;
    const expectedCount = isLast ? firstTotal - (expectedPages - 1) * firstPageSize : firstPageSize;
    if (env2.stopPoints.length !== expectedCount) {
      failExit(
        "PAGING-PAGE-COUNT",
        `page ${page} returned ${env2.stopPoints.length} stops; paging math requires exactly ${expectedCount}`,
      );
    }

    for (let i = 0; i < env2.stopPoints.length; i++) {
      const st = normalizeStop(env2.stopPoints[i]);
      if (!st) {
        failExit("PAGING-STOP-BAD", `malformed stop entry at position ${i} on page ${page}`);
      }
      if (seenIds.has(st.id)) {
        failExit("PAGING-DUPLICATE", `stop id ${st.id} appeared more than once`);
      }
      seenIds.add(st.id);
      stops.push(st);
    }
    pagesFetched = page;
    log(`page ${page}: ${env2.stopPoints.length} stops, cumulative ${stops.length}`);

    if (isLast) break;
    await pause(INTERPAGE_MS);
  }

  if (stops.length !== firstTotal) {
    failExit("PAGING-INCOMPLETE", `retrieved ${stops.length} unique stops but the API declared ${firstTotal}`);
  }

  const collator = new Intl.Collator("en", { sensitivity: "base" });
  stops.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const indexText = JSON.stringify(stops);
  const check = checkIndexBytes(indexText);
  if (!check.ok) failExit("GENERATED-BAD", `generated index failed its own contract: ${check.code} (${check.why})`);
  const indexBytes = Buffer.byteLength(indexText, "utf8");
  const indexSha = sha256OfBytes(Buffer.from(indexText, "utf8"));
  const metaSource = apiBase.origin + apiBase.pathname;

  const pub = publishAtomic(INDEX_FILE, indexText);
  if (pub.error) failExit(pub.code, `index publication failed: ${pub.why}`);

  const meta = {
    format: META_FORMAT,
    generator: "scripts/download-bus-stops.mjs",
    generatedAt: new Date().toISOString(),
    source: metaSource,
    keyUsed: apiKey !== "",
    pages: pagesFetched,
    records: stops.length,
    bytes: indexBytes,
    sha256: indexSha,
  };
  const metaText = JSON.stringify(meta, null, 2) + "\n";
  const metaCheck = checkMetaObject(meta, { bytes: indexBytes, sha256: indexSha, records: stops.length });
  if (!metaCheck.ok) failExit("META-INTERNAL", `sidecar failed its own contract: ${metaCheck.code} (${metaCheck.why})`);

  const metaFile = INDEX_FILE.replace(/\.json$/, ".meta.json");
  const pubMeta = publishAtomic(metaFile, metaText);
  if (pubMeta.error) {
    // Index is committed; the sidecar write failed. State is honest (index
    // present, provenance missing = historical) but the run still failed.
    failExit(pubMeta.code, `sidecar publication failed (index itself is published): ${pubMeta.why}`);
  }

  // Final readback: the published bytes are exactly what we validated.
  const rb = readFileSync(INDEX_FILE);
  if (sha256OfBytes(rb) !== indexSha || rb.length !== indexBytes) {
    failExit("READBACK", "published index bytes differ from the validated bytes");
  }
  log(`wrote ${relative(process.cwd(), INDEX_FILE)} (${indexBytes} bytes, sha256 ${indexSha.slice(0, 12)}..., ${stops.length} stops, ${pagesFetched} pages)`);
  log(`wrote provenance sidecar ${relative(process.cwd(), metaFile)}`);
  log("OK: bus stop index regenerated");
}

main().catch((e) => {
  log(`ERROR INTERNAL: unexpected failure: ${e?.message ?? e}`);
  exit(1);
});
