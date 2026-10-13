#!/usr/bin/env node
// Standalone validator for the generated bus stop index.
//
// Usage:
//   node scripts/validate-bus-stops.mjs [path] [--json]
//                                         [--require-generated]
//                                         [--allow-synthetic-source]
//
// Checks the strict index contract (see scripts/lib/bus-stops-schema.mjs).
// Files are read with a bounded regular-file read (open-no-follow, fstat
// size/type bound, rejects growth/excess; byte count comes from the actual
// bytes). When the provenance sidecar (<path>.meta.json) exists it must
// match the index bytes exactly (sha256, size, record count, src rules);
// anything else is invalid. Provenance classes:
//   "generated"  a matching sidecar records the official TfL endpoint;
//                offline validation does not authenticate download history.
//   "synthetic"  loopback http base (synthetic checks). NOT accepted by
//                --require-generated unless --allow-synthetic-source is
//                also passed; a loopback sidecar is not real TfL provenance.
//   "unknown"    no sidecar; shape-checked only, never claimed as a fresh
//                download.
//
// Exit codes: 0 valid · 1 invalid · 2 valid shape but provenance
// requirement unmet (missing/unknown, or synthetic without the opt-in flag).

import { statSync } from "node:fs";
import { exit } from "node:process";
import {
  checkIndexBytes,
  checkMetaObject,
  MAX_INDEX_BYTES,
  MAX_META_BYTES,
  metaPathFor,
  readBoundedFile,
  sha256OfBytes,
} from "./lib/bus-stops-schema.mjs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const requireGenerated = args.includes("--require-generated");
const allowSyntheticSource = args.includes("--allow-synthetic-source");
const paths = args.filter((a) => !a.startsWith("--") && a !== "-");
const indexPath = paths[0] ?? "lib/bus-stops.json";

const KNOWN_FLAGS = ["--json", "--require-generated", "--allow-synthetic-source"];
if (paths.length > 1 || args.some((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a))) {
  process.stderr.write("usage: node scripts/validate-bus-stops.mjs [path] [--json] [--require-generated] [--allow-synthetic-source]\n");
  exit(64);
}

function finish(result) {
  if (jsonOut) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    for (const l of result.lines) process.stdout.write(l + "\n");
  }
  let code = result.ok ? 0 : 1;
  if (result.ok && requireGenerated && result.provenanceUnmet) code = 2;
  exit(code);
}

const result = {
  ok: false,
  provenance: "unknown",
  provenanceUnmet: false,
  path: indexPath,
  records: null,
  bytes: null,
  sha256: null,
  generatedAt: null,
  source: null,
  sourceClass: null,
  lines: [],
};
const note = (l) => result.lines.push(l);

// Bounded read: no unbounded readFileSync after a separate stat.
const rbIndex = readBoundedFile(indexPath, MAX_INDEX_BYTES);
if (!rbIndex.ok) {
  result.lines = [`invalid: ${rbIndex.code}: ${rbIndex.why}`];
  finish(result);
}

const text = rbIndex.buf.toString("utf8");
result.bytes = rbIndex.bytes;
result.sha256 = sha256OfBytes(rbIndex.buf);

const c = checkIndexBytes(text);
if (!c.ok) {
  result.lines = [`invalid: ${c.code}: ${c.why}`];
  finish(result);
}
result.records = c.records;
note(`index: ok (${c.records} records, ${rbIndex.bytes} bytes, sha256 ${result.sha256})`);

const metaFile = metaPathFor(indexPath);
let metaExists = false;
try {
  statSync(metaFile);
  metaExists = true;
} catch {}

if (metaExists) {
  const rbMeta = readBoundedFile(metaFile, MAX_META_BYTES);
  if (!rbMeta.ok) {
    result.lines = [`invalid: ${rbMeta.code}: sidecar ${rbMeta.why}`];
    finish(result);
  }
  let meta;
  try {
    meta = JSON.parse(rbMeta.buf.toString("utf8"));
  } catch {
    result.lines = [`invalid: META-PARSE: sidecar is not valid JSON (provenance claim unreadable)`];
    finish(result);
  }
  const m = checkMetaObject(meta, { bytes: rbIndex.bytes, sha256: result.sha256, records: result.records });
  if (!m.ok) {
    result.lines = [`invalid: ${m.code}: ${m.why}`];
    finish(result);
  }
  result.sourceClass = m.sourceClass;
  result.provenance = m.sourceClass === "official" ? "generated" : "synthetic";
  result.generatedAt = meta.generatedAt;
  result.source = meta.source;
  result.keyUsed = meta.keyUsed;
  note(m.sourceClass === "official"
    ? `provenance: recorded generation ${meta.generatedAt} by ${meta.generator} (${meta.pages} pages, keyUsed ${meta.keyUsed}, source ${meta.source}); download history not authenticated offline`
    : `provenance: synthetic ${meta.generatedAt} by ${meta.generator} (${meta.pages} pages, keyUsed ${meta.keyUsed}, synthetic source — not official TfL provenance)`);
  if (requireGenerated && m.sourceClass !== "official" && !allowSyntheticSource) {
    result.provenanceUnmet = true;
    note("requirement: --require-generated but an official-TfL generation record is absent (exit 2)");
  }
} else {
  result.provenance = "unknown";
  note("provenance: unknown (no provenance sidecar; historical index — not claimed as a fresh download)");
  if (requireGenerated) {
    result.provenanceUnmet = true;
    note("requirement: --require-generated but provenance is unknown (exit 2)");
  }
}

result.ok = true;
finish(result);
