#!/usr/bin/env node
// Standalone validator for the generated bus stop index.
//
// Usage:
//   node scripts/validate-bus-stops.mjs [path] [--json] [--require-generated]
//
// Checks the strict index contract (see scripts/lib/bus-stops-schema.mjs).
// When the provenance sidecar (<path>.meta.json) exists, it must match the
// index bytes exactly (sha256, size, record count, parameter-free source);
// anything else is invalid. A missing sidecar means the index shape itself is
// checked but its provenance is reported as unknown — never claimed as a
// fresh download. --require-generated turns unknown provenance into exit 2.
//
// Exit codes: 0 valid · 1 invalid · 2 valid but provenance required and unknown.

import { readFileSync, statSync } from "node:fs";
import { exit } from "node:process";
import {
  checkIndexBytes,
  checkMetaObject,
  MAX_INDEX_BYTES,
  MAX_META_BYTES,
  metaPathFor,
  sha256OfBytes,
  statRegularWithinCap,
} from "./lib/bus-stops-schema.mjs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const requireGenerated = args.includes("--require-generated");
const paths = args.filter((a) => !a.startsWith("--") && a !== "-");
const indexPath = paths[0] ?? "lib/bus-stops.json";

if (paths.length > 1 || args.some((a) => a.startsWith("--") && !["--json", "--require-generated"].includes(a))) {
  process.stderr.write("usage: node scripts/validate-bus-stops.mjs [path] [--json] [--require-generated]\n");
  exit(64);
}

function finish(result) {
  if (jsonOut) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    for (const l of result.lines) process.stdout.write(l + "\n");
  }
  exit(result.ok ? (requireGenerated && result.provenance === "unknown" ? 2 : 0) : 1);
}

const result = { ok: false, provenance: "unknown", path: indexPath, records: null, bytes: null, sha256: null, generatedAt: null, source: null, lines: [] };
const note = (l) => result.lines.push(l);

let st;
{
  const s = statRegularWithinCap(indexPath, MAX_INDEX_BYTES);
  if (s.error) {
    result.lines = [`invalid: ${indexPath} (${s.error.message})`];
    finish(result);
  }
  st = s.st;
}

let text;
let index;
{
  const bytes = readFileSync(indexPath);
  text = bytes.toString("utf8");
  result.bytes = st.size;
  result.sha256 = sha256OfBytes(bytes);

  const c = checkIndexBytes(text);
  if (!c.ok) {
    result.lines = [`invalid: ${c.code}: ${c.why}`];
    finish(result);
  }
  index = c.stops;
  result.records = c.records;
  note(`index: ok (${c.records} records, ${st.size} bytes, sha256 ${result.sha256})`);
}

const metaFile = metaPathFor(indexPath);
let metaExists = false;
try {
  statSync(metaFile);
  metaExists = true;
} catch {}

if (metaExists) {
  const ms = statRegularWithinCap(metaFile, MAX_META_BYTES);
  if (ms.error) {
    result.lines = [`invalid: ${metaFile} (${ms.error.message})`];
    result.ok = false;
    finish(result);
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaFile, "utf8"));
  } catch {
    result.lines = [`invalid: META-PARSE: ${metaFile} is not valid JSON (provenance claim unreadable)`];
    finish(result);
  }
  const m = checkMetaObject(meta, { bytes: st.size, sha256: result.sha256, records: result.records });
  if (!m.ok) {
    result.lines = [`invalid: ${m.code}: ${m.why}`];
    finish(result);
  }
  result.provenance = "generated";
  result.generatedAt = meta.generatedAt;
  result.source = meta.source;
  result.keyUsed = meta.keyUsed;
  note(`provenance: generated ${meta.generatedAt} by ${meta.generator} (${meta.pages} pages, keyUsed ${meta.keyUsed}, source ${meta.source})`);
} else {
  result.provenance = "unknown";
  note("provenance: unknown (no provenance sidecar; historical index — not claimed as a fresh download)");
}

result.ok = true;
if (requireGenerated && result.provenance === "unknown") {
  note("requirement: --require-generated but provenance is unknown (exit 2)");
}
finish(result);
