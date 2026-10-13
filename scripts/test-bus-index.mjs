#!/usr/bin/env node
// Synthetic checks for the bus stop index generator and validator.
//
//   node scripts/test-bus-index.mjs            (prints a summary)
//   BUS_INDEX_TEST_REPORT=<path> node ...      (also writes machine evidence)
//
// Runs the ACTUAL CLIs (scripts/download-bus-stops.mjs and
// scripts/validate-bus-stops.mjs, copied into an isolated workspace) against
// local node:http synthetic TfL paging servers on loopback. No live API
// calls, no installations; children run with private HOME/TMPDIR and a
// bounded threadpool; each case is killed at 55 s (below the 60 s cap).
// Exits non-zero when any case fails.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env, exit } from "node:process";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const REPORT = env.BUS_INDEX_TEST_REPORT ?? null;
const TEST_KEY = "TFLTESTKEY-abc123XYZ-secret";
const CASE_TIMEOUT_MS = 55_000;

const results = [];
let serverCount = 0;

// ---------- small helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function checkNoSecret(label, text) {
  if (text.includes(TEST_KEY)) throw new Error(`${label} contains the API key`);
  if (text.includes("app_key=")) throw new Error(`${label} contains "app_key="`);
}

// ---------- synthetic paging server ----------

function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
    try {
      handler(req, res, u);
    } catch (e) {
      try {
        res.writeHead(500);
        res.end();
      } catch {}
    }
  });
  const portReady = new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  serverCount++;
  return {
    requests,
    portPromise: portReady,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function tflStops(count, nameOffset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    naptanId: `4900T${String(i + 1).padStart(5, "0")}`,
    commonName: `Test Stop ${String(i + 1 + nameOffset).padStart(5, "0")}`,
    lat: 51.5 + (i + 1) / 100,
    lon: -0.1 - (i + 1) / 100,
    indicator: `Stop ${i + 1}`,
  }));
}

const envelope = (page, total, pageSize, stopPoints) =>
  JSON.stringify({ total, pageSize, currentPage: page, stopPoints });

// Replicates the generator's normalize+sort to compute expected output.
function expectedIndex(tflStops_) {
  const normalized = tflStops_.map((s) => ({
    id: s.naptanId,
    name: s.commonName,
    lat: s.lat,
    lon: s.lon,
    indicator: s.indicator ?? "",
  }));
  const collator = new Intl.Collator("en", { sensitivity: "base" });
  normalized.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return normalized;
}

// Handler returning canned responses per page number.
function pagesHandler(pages, opts = {}) {
  return (req, res, u) => {
    const page = Number(u.searchParams.get("page") ?? "1");
    const rule = pages[page];
    if (!rule) {
      res.writeHead(500);
      res.end();
      return;
    }
    const delay = rule.delayMs ?? opts.defaultDelayMs ?? 0;
    setTimeout(() => {
      if (rule.hang) return;
      if (rule.status && rule.status !== 200) {
        res.writeHead(rule.status);
        res.end(rule.body ?? "");
        return;
      }
      if (rule.redirect) {
        res.writeHead(rule.status ?? 302, { location: rule.redirect });
        res.end();
        return;
      }
      const body = rule.body ?? "";
      const cbytes = Buffer.byteLength(body);
      if (rule.truncate) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body.slice(0, Math.max(1, Math.floor(cbytes / 2))));
        return;
      }
      if (rule.dribbleBytes) {
        res.writeHead(200, { "content-type": "application/json" });
        let sent = 0;
        const chunk = Buffer.alloc(1024, 0x41);
        const timer = setInterval(() => {
          res.write(chunk);
          sent += chunk.length;
          if (sent >= rule.dribbleBytes) {
            clearInterval(timer);
            res.end();
          }
        }, 5);
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    }, delay);
  };
}

// ---------- isolated workspace + child runs ----------

const REAL_GEN = join(SCRIPTS_DIR, "download-bus-stops.mjs");
const REAL_VAL = join(SCRIPTS_DIR, "validate-bus-stops.mjs");
const REAL_SCHEMA = join(SCRIPTS_DIR, "lib", "bus-stops-schema.mjs");

const BASE_TMP = mkdtempSync(join(env.TMPDIR ?? "/tmp", "tfl-bus-index-tests-"));
let wsCounter = 0;

function makeWs({ seedIndex, seedMeta } = {}) {
  wsCounter++;
  const ws = join(BASE_TMP, `ws-${wsCounter}`);
  mkdirSync(join(ws, "scripts", "lib"), { recursive: true });
  mkdirSync(join(ws, "lib"), { recursive: true });
  mkdirSync(join(ws, "home"), { recursive: true });
  mkdirSync(join(ws, "tmp"), { recursive: true });
  copyFileSync(REAL_GEN, join(ws, "scripts", "download-bus-stops.mjs"));
  copyFileSync(REAL_VAL, join(ws, "scripts", "validate-bus-stops.mjs"));
  copyFileSync(REAL_SCHEMA, join(ws, "scripts", "lib", "bus-stops-schema.mjs"));
  if (seedIndex) writeFileSync(join(ws, "lib", "bus-stops.json"), seedIndex);
  if (seedMeta) writeFileSync(join(ws, "lib", "bus-stops.meta.json"), seedMeta);
  return ws;
}

function wsFile(ws, rel) {
  return readFileSync(join(ws, rel), "utf8");
}

function baseEnv(ws) {
  return {
    PATH: env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: join(ws, "home"),
    TMPDIR: join(ws, "tmp"),
    UV_THREADPOOL_SIZE: "2",
  };
}

function runChild(ws, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ws,
      env: { ...baseEnv(ws), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CASE_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started, timedOut });
    });
  });
}

// Runs the generator CLI against a loopback page server.
async function runGenerator(ws, port, extraEnv = {}) {
  return runChild(
    ws,
    ["scripts/download-bus-stops.mjs"],
    {
      TFL_STOPS_BASE_URL: `http://127.0.0.1:${port}/StopPoint/Mode/bus`,
      TFL_STOPS_PAUSE_MS: "10",
      ...extraEnv,
    },
  );
}

function runValidator(ws, extraArgs = [], extraEnv = {}) {
  return runChild(ws, ["scripts/validate-bus-stops.mjs", "lib/bus-stops.json", ...extraArgs], extraEnv);
}

// ---------- case runner ----------

async function runCase(name, fn) {
  const t0 = Date.now();
  const servers = [];
  const note = {};
  try {
    const res = await fn({
      startServer: (h) => {
        const s = startServer(h);
        servers.push(s);
        return s;
      },
      note: (k, v) => (note[k] = v),
    });
    for (const s of servers) await s.close();
    const ms = Date.now() - t0;
    const ok = true;
    results.push({ name, ok, ms, ...note, detail: res?.detail ?? null });
    console.log(`PASS ${name} (${ms}ms)`);
  } catch (e) {
    for (const s of servers) await s.close().catch(() => {});
    const ms = Date.now() - t0;
    results.push({ name, ok: false, ms, error: String(e?.message ?? e) });
    console.log(`FAIL ${name} (${ms}ms): ${e?.message ?? e}`);
  }
}

// ---------- common seeds ----------

const GOOD_TFL = tflStops(5);
const GOOD_PAGES = { 1: { body: envelope(1, 5, 3, GOOD_TFL.slice(0, 3)) }, 2: { body: envelope(2, 5, 3, GOOD_TFL.slice(3, 5)) } };
const goodEnvelopeBytes = Buffer.from(JSON.stringify(expectedIndex(GOOD_TFL)), "utf8");
const goodMetaText = JSON.stringify({
  format: "tfl-bus-stops-index/1",
  generator: "scripts/download-bus-stops.mjs",
  generatedAt: "2026-10-13T10:00:00Z",
  source: "https://api.tfl.gov.uk/StopPoint/Mode/bus",
  keyUsed: false,
  pages: 2,
  records: 5,
  bytes: goodEnvelopeBytes.length,
  sha256: sha256(goodEnvelopeBytes),
}, null, 2) + "\n";

// ---------- generator cases ----------

await runCase("happy-no-key", async ({ startServer, note }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler(GOOD_PAGES));
  const port = await server.portPromise;
  const r = await runGenerator(ws, port);
  assert(r.code === 0, `generator exit ${r.code}: ${r.stderr}`);
  assert(!r.timedOut, "generator timed out");
  assert(JSON.parse(wsFile(ws, "lib/bus-stops.json")), "index parses");
  assert(JSON.parse(wsFile(ws, "lib/bus-stops.json"))[0].name === "Test Stop 00001", "sorted content");
  const meta = JSON.parse(wsFile(ws, "lib/bus-stops.meta.json"));
  assert(meta.keyUsed === false && meta.pages === 2 && meta.records === 5, "meta facts");
  assert(server.requests.every((q) => !("app_key" in q.query)), "no app_key sent");
  const v = await runValidator(ws, ["--json"]);
  assert(v.code === 0, `validator exit ${v.code}`);
  const out = JSON.parse(v.stdout);
  assert(out.provenance === "generated", "provenance generated");
  note.records = meta.records;
  return { detail: "index+meta validated through real CLIs" };
});

await runCase("happy-content-equals-expected", async ({ startServer }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler(GOOD_PAGES));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code === 0, `generator exit ${r.code}: ${r.stderr}`);
  const produced = wsFile(ws, "lib/bus-stops.json");
  assert(produced === JSON.stringify(expectedIndex(GOOD_TFL)), "byte-equal to expected normalized sort");
  return { detail: "byte-equal content" };
});

await runCase("happy-with-key-server-receives-key", async ({ startServer }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler(GOOD_PAGES));
  const r = await runGenerator(ws, await server.portPromise, { TFL_API_KEY: TEST_KEY });
  assert(r.code === 0, `generator exit ${r.code}: ${r.stderr}`);
  assert(server.requests.length >= 2, "both pages requested");
  assert(server.requests.every((q) => q.query.app_key === TEST_KEY), "app_key sent to the API");
  checkNoSecret("generator stdout", r.stdout);
  checkNoSecret("generator stderr", r.stderr);
  checkNoSecret("index file", wsFile(ws, "lib/bus-stops.json"));
  checkNoSecret("meta file", wsFile(ws, "lib/bus-stops.meta.json"));
  const meta = JSON.parse(wsFile(ws, "lib/bus-stops.meta.json"));
  assert(meta.keyUsed === true, "meta.keyUsed true");
  return { detail: "key reached server, never in outputs/files" };
});

await runCase("http-error-secret-free-errors", async ({ startServer }) => {
  const ws = makeWs({ seedIndex: goodEnvelopeBytes.toString("utf8"), seedMeta: goodMetaText });
  const beforeIndex = wsFile(ws, "lib/bus-stops.json");
  const beforeMeta = wsFile(ws, "lib/bus-stops.meta.json");
  const server = startServer(pagesHandler({ 1: { status: 500, body: "boom" }, 2: { status: 200 } }));
  const r = await runGenerator(ws, await server.portPromise, { TFL_API_KEY: TEST_KEY });
  assert(r.code !== 0, "generator must fail");
  assert(r.stderr.includes("FETCH-HTTP-STATUS-500"), `saw 500 code: ${r.stderr}`);
  checkNoSecret("generator stdout", r.stdout);
  checkNoSecret("generator stderr", r.stderr);
  assert(wsFile(ws, "lib/bus-stops.json") === beforeIndex, "previous index unchanged");
  assert(wsFile(ws, "lib/bus-stops.meta.json") === beforeMeta, "previous meta unchanged");
  const leftovers = readdirSync(join(ws, "lib")).filter((f) => f.includes("tmp-atomic"));
  assert(leftovers.length === 0, `no tmp leftovers (${leftovers})`);
  return { detail: "5xx retried once then failed clean" };
});

await runCase("redirect-single-hop-followed", async ({ startServer }) => {
  const ws = makeWs();
  // Same-origin single redirect: first hit on page 1 redirects; the second
  // hit (marker r=1) serves the real page 1 body.
  const server = startServer((req, res, u) => {
    const page = Number(u.searchParams.get("page"));
    if (page === 1 && u.searchParams.get("r") !== "1") {
      res.writeHead(302, { location: "/StopPoint/Mode/bus?page=1&r=1" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(envelope(page, 5, 3, page === 1 ? GOOD_TFL.slice(0, 3) : GOOD_TFL.slice(3, 5)));
  });
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code === 0, `generator exit ${r.code}: ${r.stderr}`);
  assert(server.requests.some((q) => q.query.r === "1"), "redirect target was fetched");
  return { detail: "one same-origin redirect followed" };
});

await runCase("redirect-chain-exceeds-cap", async ({ startServer }) => {
  const ws = makeWs();
  let hop = 0;
  const server = startServer((req, res, u) => {
    hop++;
    res.writeHead(302, { location: `/StopPoint/Mode/bus?page=1&hop=${hop + 1}` });
    res.end();
  });
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code !== 0, "generator must fail");
  assert(r.stderr.includes("FETCH-REDIRECTS"), `saw redirect cap error: ${r.stderr}`);
  assert(hop <= 3, `bounded hops (got ${hop})`);
  return { detail: "chained redirects refused" };
});

await runCase("redirect-cross-origin-refused", async ({ startServer }) => {
  const ws = makeWs();
  const evil = startServer((req, res) => {
    res.writeHead(200);
    res.end('{"total":1,"pageSize":1,"currentPage":1,"stopPoints":[]}');
  });
  const evilPort = await evil.portPromise;
  const server = startServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/evil` });
    res.end();
  });
  const r = await runGenerator(ws, await server.portPromise, { TFL_API_KEY: TEST_KEY });
  assert(r.code !== 0, "generator must fail");
  assert(r.stderr.includes("FETCH-URL-BAD"), `origin refusal: ${r.stderr}`);
  assert(evil.requests.length === 0, "cross-origin server was never contacted");
  checkNoSecret("generator stderr", r.stderr);
  return { detail: "cross-origin redirect refused; key never sent anywhere" };
});

await runCase("oversize-body-aborts", async ({ startServer }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler({ 1: { dribbleBytes: 16 * 1024 } }));
  const r = await runGenerator(ws, await server.portPromise, { TFL_STOPS_MAX_PAGE_BYTES: "4096" });
  assert(r.code !== 0, "generator must fail");
  assert(r.stderr.includes("FETCH-OVERSIZE-BODY"), `oversize error: ${r.stderr}`);
  const stat = statSync(join(ws, "lib/bus-stops.json"), { throwIfNoEntry: false });
  assert(stat === undefined, "no index was published");
  return { detail: "streaming body over per-page cap refused" };
});

await runCase("truncated-body-fails", async ({ startServer }) => {
  const ws = makeWs({ seedIndex: goodEnvelopeBytes.toString("utf8"), seedMeta: goodMetaText });
  const beforeIndex = wsFile(ws, "lib/bus-stops.json");
  const full = envelope(1, 5, 3, GOOD_TFL.slice(0, 3));
  const server = startServer(pagesHandler({ 1: { truncate: true, status: 0, body: full } }));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code !== 0, "generator must fail");
  assert(r.stderr.includes("FETCH-PARSE"), `parse error: ${r.stderr}`);
  assert(wsFile(ws, "lib/bus-stops.json") === beforeIndex, "previous index unchanged");
  return { detail: "partial JSON body detected" };
});

await runCase("paging-missing-total", async ({ startServer }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler({
    1: { body: JSON.stringify({ pageSize: 1000, currentPage: 1, stopPoints: tflStops(2) }) },
  }));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code !== 0, "generator must fail");
  assert(r.stderr.includes("PAGING-TOTAL-BAD"), `total check: ${r.stderr}`);
  return { detail: "absent total is not silent completion" };
});

await runCase("paging-defaults-refused", async ({ startServer }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler({
    1: { body: JSON.stringify({ total: 5, pageSize: 0, currentPage: 1, stopPoints: [] }) },
  }));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code !== 0 && r.stderr.includes("PAGING-PAGESIZE-BAD"), `pageSize check: ${r.stderr}`);
  return { detail: "pageSize 0 refused" };
});

await runCase("paging-currentpage-mismatch", async ({ startServer }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler({
    1: { body: envelope(7, 5, 3, GOOD_TFL.slice(0, 3)) },
  }));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code !== 0 && r.stderr.includes("PAGING-CURRENTPAGE-BAD"), `currentPage check: ${r.stderr}`);
  return { detail: "currentPage must match requested page" };
});

await runCase("paging-count-mismatch", async ({ startServer }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler({
    1: { body: envelope(1, 6, 5, tflStops(4)) },
  }));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code !== 0 && r.stderr.includes("PAGING-PAGE-COUNT"), `page count check: ${r.stderr}`);
  return { detail: "page 1 short by one refused (cumulative < total caught)" };
});

await runCase("paging-inconsistent-total", async ({ startServer }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler({
    1: { body: envelope(1, 5, 3, GOOD_TFL.slice(0, 3)) },
    2: { body: envelope(2, 7, 3, GOOD_TFL.slice(3, 5)) },
  }));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code !== 0 && r.stderr.includes("PAGING-INCONSISTENT"), `consistency check: ${r.stderr}`);
  return { detail: "mid-run metadata change refused" };
});

await runCase("duplicates-within-page", async ({ startServer }) => {
  const ws = makeWs();
  const dup = GOOD_TFL.slice(0, 2);
  const arr = [dup[0], dup[1], dup[0]];
  const server = startServer(pagesHandler({ 1: { body: envelope(1, 3, 3, arr) } }));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code !== 0 && r.stderr.includes("PAGING-DUPLICATE"), `dup check: ${r.stderr}`);
  return { detail: "within-page duplicate id fatal" };
});

await runCase("duplicates-across-pages", async ({ startServer }) => {
  const ws = makeWs();
  // Page 2 is correctly sized (2 stops) but repeats page 1's first id.
  const server = startServer(pagesHandler({
    1: { body: envelope(1, 5, 3, GOOD_TFL.slice(0, 3)) },
    2: { body: envelope(2, 5, 3, [GOOD_TFL[0], GOOD_TFL[3]]) },
  }));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code !== 0 && r.stderr.includes("PAGING-DUPLICATE"), `dup check: ${r.stderr}`);
  return { detail: "cross-page duplicate id fatal" };
});

await runCase("first-page-timeout", async ({ startServer }) => {
  const ws = makeWs();
  const server = startServer(pagesHandler({ 1: { hang: true } }));
  const r = await runGenerator(ws, await server.portPromise, { TFL_STOPS_TIMEOUT_MS: "300" });
  assert(r.code !== 0 && r.stderr.includes("FETCH-HTTP-TIMEOUT"), `timeout check: ${r.stderr}`);
  assert(r.ms < 20_000, `bounded run time (${r.ms}ms)`);
  return { detail: "hang detected within deadline" };
});

await runCase("unchanged-previous-good-index", async ({ startServer }) => {
  const ws = makeWs({ seedIndex: goodEnvelopeBytes.toString("utf8"), seedMeta: goodMetaText });
  // Serve the same logical content but in a different page order/shape.
  const shuffled = [...GOOD_TFL].reverse();
  const server = startServer(pagesHandler({
    1: { body: envelope(1, 5, 3, shuffled.slice(0, 3)) },
    2: { body: envelope(2, 5, 3, shuffled.slice(3, 5)) },
  }));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code === 0, `generator exit ${r.code}: ${r.stderr}`);
  assert(wsFile(ws, "lib/bus-stops.json") === goodEnvelopeBytes.toString("utf8"), "index bytes unchanged for identical content");
  const meta = JSON.parse(wsFile(ws, "lib/bus-stops.meta.json"));
  assert(meta.generatedAt !== "2026-10-13T10:00:00Z", "sidecar refreshed");
  const v = await runValidator(ws);
  assert(v.code === 0, "validator accepts refreshed pair");
  return { detail: "same content -> same index bytes, fresh metadata" };
});

await runCase("stale-tmp-cleaned-and-rerun-ok", async ({ startServer }) => {
  const ws = makeWs({ seedIndex: goodEnvelopeBytes.toString("utf8"), seedMeta: goodMetaText });
  writeFileSync(join(ws, "lib", "bus-stops.json.tmp-atomic"), "junk");
  const server = startServer(pagesHandler(GOOD_PAGES));
  const r = await runGenerator(ws, await server.portPromise);
  assert(r.code === 0, `generator exit ${r.code}: ${r.stderr}`);
  assert(JSON.parse(wsFile(ws, "lib/bus-stops.json")), "fresh index published over stale tmp");
  return { detail: "dead-run temporaries removed at start" };
});

await runCase("interrupted-before-commit", async ({ startServer }) => {
  const ws = makeWs({ seedIndex: goodEnvelopeBytes.toString("utf8"), seedMeta: goodMetaText });
  const beforeIndex = wsFile(ws, "lib/bus-stops.json");
  const beforeMeta = wsFile(ws, "lib/bus-stops.meta.json");
  const portPromise = new Promise((resolve) => {
    const server = http.createServer((req, res, u) => {
      const page = Number(new URL(req.url ?? "/", "http://x").searchParams.get("page"));
      if (page === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(envelope(1, 5, 3, GOOD_TFL.slice(0, 3)));
      }
      // page 2 never responds
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    serverCount++;
  });
  const port = await portPromise;
  const started = Date.now();
  const child = spawn(process.execPath, ["scripts/download-bus-stops.mjs"], {
    cwd: ws,
    env: {
      ...baseEnv(ws),
      TFL_STOPS_BASE_URL: `http://127.0.0.1:${port}/StopPoint/Mode/bus`,
      TFL_STOPS_PAUSE_MS: "10",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (stderr.includes("page 1:")) {
        clearInterval(t);
        resolve();
      }
    }, 20);
  });
  child.kill("SIGKILL");
  await new Promise((r) => child.on("close", r));
  assert(Date.now() - started < 20_000, "killed promptly");
  const leftovers = readdirSync(join(ws, "lib")).filter((f) => f.includes("tmp-atomic"));
  assert(leftovers.length === 0, `no tmp leftovers (${leftovers})`);
  assert(wsFile(ws, "lib/bus-stops.json") === beforeIndex, "previous index unchanged");
  assert(wsFile(ws, "lib/bus-stops.meta.json") === beforeMeta, "previous meta unchanged");
  return { detail: "kill mid-paging leaves the previous good publication intact" };
});

// ---------- validator fixture cases ----------

function fixtureWs(indexText, metaText) {
  return makeWs({ seedIndex: indexText, seedMeta: metaText });
}

const singleStop = JSON.stringify([{ id: "49000123A", name: "Alpha Street", lat: 51.5, lon: -0.12, indicator: "Stop A" }]);
const singleMeta = (bytes, rec) => JSON.stringify({
  format: "tfl-bus-stops-index/1",
  generator: "scripts/download-bus-stops.mjs",
  generatedAt: "2026-10-13T10:00:00Z",
  source: "https://api.tfl.gov.uk/StopPoint/Mode/bus",
  keyUsed: false,
  pages: 1,
  records: rec,
  bytes,
  sha256: sha256(Buffer.from(singleStop, "utf8")),
}, null, 2) + "\n";

await runCase("validator-pair-json-output", async () => {
  const ws = fixtureWs(singleStop, singleMeta(Buffer.byteLength(singleStop), 1));
  const v = await runValidator(ws, ["--json"]);
  assert(v.code === 0, `exit ${v.code}: ${v.stderr}`);
  const out = JSON.parse(v.stdout);
  assert(out.ok === true && out.provenance === "generated" && out.records === 1, "json fields");
  return { detail: "--json machine output" };
});

await runCase("validator-historical-and-require", async () => {
  const ws = fixtureWs(singleStop, null);
  let v = await runValidator(ws);
  assert(v.code === 0, `historical exit ${v.code}`);
  assert(v.stdout.includes("provenance: unknown"), "unknown provenance wording");
  v = await runValidator(ws, ["--require-generated"]);
  assert(v.code === 2, `require-generated exit ${v.code}`);
  return { detail: "no sidecar -> ok/unknown; --require-generated -> 2" };
});

await runCase("validator-tampered-index", async () => {
  const ws = fixtureWs(singleStop, singleMeta(Buffer.byteLength(singleStop), 1));
  writeFileSync(join(ws, "lib", "bus-stops.json"), singleStop.replace("Alpha Street", "Beta Street"));
  const v = await runValidator(ws);
  assert(v.code === 1, `exit ${v.code}`);
  assert(v.stdout.includes("META-SHA") || v.stdout.includes("invalid"), "sha mismatch surfaced");
  return { detail: "byte tamper vs matching meta detected" };
});

await runCase("validator-bad-entries", async () => {
  const cases = [
    ["lat-string", JSON.stringify([{ id: "49000123A", name: "A", lat: "51.5", lon: -0.1, indicator: "" }]), "INDEX-LAT"],
    ["missing-indicator", JSON.stringify([{ id: "49000123A", name: "A", lat: 51.5, lon: -0.1 }]), "INDEX-KEYS"],
    ["extra-field", JSON.stringify([{ id: "49000123A", name: "A", lat: 51.5, lon: -0.1, indicator: "", zone: 1 }]), "INDEX-KEYS"],
    ["bad-id", JSON.stringify([{ id: "x", name: "A", lat: 51.5, lon: -0.1, indicator: "" }]), "INDEX-ID"],
    ["dup-ids", JSON.stringify([{ id: "49000123A", name: "A", lat: 51.5, lon: -0.1, indicator: "" }, { id: "49000123A", name: "B", lat: 51.6, lon: -0.2, indicator: "" }]), "INDEX-DUPLICATE"],
    ["empty", "[]", "INDEX-EMPTY"],
    ["truncated", '{"id":"4900', "INDEX-PARSE"],
    ["non-array", '{"total":1}', "INDEX-ARRAY"],
    ["infinity", JSON.stringify([{ id: "49000123A", name: "A", lat: 1e999, lon: -0.1, indicator: "" }]), "INDEX-LAT"],
  ];
  for (const [name, text, code] of cases) {
    const ws = fixtureWs(text, null);
    const v = await runValidator(ws);
    assert(v.code === 1, `${name}: exit ${v.code}`);
    assert(v.stdout.includes(code), `${name}: expected ${code}, got: ${v.stdout}`);
  }
  return { detail: `${cases.length} shape violations rejected` };
});

await runCase("validator-meta-mismatches", async () => {
  const base = singleMeta(Buffer.byteLength(singleStop), 1);
  const cases = [
    ["sha-mismatch", base.replace(/"sha256": "[0-9a-f]+"/, '"sha256": "' + "ab".repeat(32) + '"'), "META-SHA"],
    ["records-mismatch", base.replace('"records": 1', '"records": 2'), "META-RECORDS"],
    ["bytes-mismatch", base.replace(`"bytes": ${Buffer.byteLength(singleStop)}`, '"bytes": 99'), "META-BYTES"],
    ["missing-fields", JSON.stringify({ format: "tfl-bus-stops-index/1", generator: "g", generatedAt: "2026-10-13T10:00:00Z", source: "https://api.tfl.gov.uk/StopPoint/Mode/bus" }), "META-KEYUSED"],
    ["bad-format", base.replace("tfl-bus-stops-index/1", "other/9"), "META-FORMAT"],
    ["not-json", "{oops", "META-PARSE"],
  ];
  for (const [name, meta, code] of cases) {
    const ws = fixtureWs(singleStop, meta);
    const v = await runValidator(ws);
    assert(v.code === 1, `${name}: exit ${v.code}`);
    assert(v.stdout.includes(code), `${name}: expected ${code}, got: ${v.stdout}`);
  }
  const keyInSource = base.replace(
    "https://api.tfl.gov.uk/StopPoint/Mode/bus",
    "https://api.tfl.gov.uk/StopPoint/Mode/bus?app_key=K",
  );
  const ws = fixtureWs(singleStop, keyInSource);
  const v = await runValidator(ws);
  assert(v.code === 1 && v.stdout.includes("META-SOURCE"), `keyed source rejected: ${v.stdout}`);
  const foreignBase = base.replace(
    "https://api.tfl.gov.uk/StopPoint/Mode/bus",
    "http://evil.example/StopPoint/Mode/bus",
  );
  const ws2 = fixtureWs(singleStop, foreignBase);
  const v2 = await runValidator(ws2);
  assert(v2.code === 1 && v2.stdout.includes("META-SOURCE"), `foreign source rejected: ${v2.stdout}`);
  return { detail: "7 sidecar integrity rules enforced" };
});

await runCase("validator-missing-file-and-usage", async () => {
  const ws = makeWs();
  let v = await runValidator(ws);
  assert(v.code === 1 && v.stdout.includes("invalid"), "missing index -> 1");
  v = await runValidator(ws, ["--wat"]);
  assert(v.code === 64, `unknown flag exit ${v.code}`);
  return { detail: "missing file + usage guard" };
});

await runCase("validator-oversize-file-cap", async () => {
  const ws = makeWs();
  const big = Buffer.alloc(65 * 1024 * 1024, 0x5b); // 65 MiB of '['
  writeFileSync(join(ws, "lib", "bus-stops.json"), big);
  const v = await runValidator(ws);
  assert(v.code === 1, `exit ${v.code}`);
  assert(v.stdout.includes("cap"), "cap message");
  return { detail: "65 MiB index refused before parse" };
});

// ---------- summary ----------

const totals = { pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length };
console.log(`\n${totals.pass} passed, ${totals.fail} failed (${serverCount} synthetic servers created)`);
if (REPORT) {
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify({
      when: new Date().toISOString(),
      node: process.version,
      totals,
      cases: results,
    }, null, 2) + "\n",
  );
  console.log(`evidence written to ${REPORT}`);
}
rmSync(BASE_TMP, { recursive: true, force: true });
exit(totals.fail > 0 ? 1 : 0);
