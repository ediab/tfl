#!/usr/bin/env node
// Copy a bounded, validated generation pair into a fresh native release.
// A sidecar records generation; it does not authenticate download history.
import { openSync, writeFileSync, fsyncSync, closeSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { checkIndexBytes, checkMetaObject, readBoundedFile, MAX_INDEX_BYTES, MAX_META_BYTES, metaPathFor, sha256OfBytes } from './lib/bus-stops-schema.mjs';

const [source, destination, ...extra] = process.argv.slice(2);
const owned = [];
function refuse(code) { throw new Error(code); }
try {
  if (!source || !destination || extra.length) refuse('USAGE');
  const dir = lstatSync(destination);
  if (!dir.isDirectory() || dir.isSymbolicLink()) refuse('DESTINATION-TYPE');
  const index = readBoundedFile(source, MAX_INDEX_BYTES);
  const metaPath = metaPathFor(source);
  if (!index.ok || !metaPath) refuse('SOURCE-INDEX');
  const shape = checkIndexBytes(index.buf.toString('utf8'));
  if (!shape.ok) refuse('SOURCE-SHAPE');
  const sidecar = readBoundedFile(metaPath, MAX_META_BYTES);
  if (!sidecar.ok) refuse('SOURCE-META');
  const metadata = checkMetaObject(JSON.parse(sidecar.buf.toString('utf8')), {
    bytes: index.bytes, records: shape.records, sha256: sha256OfBytes(index.buf),
  });
  if (!metadata.ok || metadata.sourceClass !== 'official') refuse('SOURCE-PROVENANCE');
  // Read both bounded source files once. Copy these verified buffers, never reopen sources.
  for (const [name, bytes] of [['bus-stops.json', index.buf], ['bus-stops.meta.json', sidecar.buf]]) {
    const target = join(destination, name);
    const fd = openSync(target, 'wx', 0o644);
    const identity = lstatSync(target);
    owned.push({ target, dev: identity.dev, ino: identity.ino });
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    const copied = readBoundedFile(target, bytes.length);
    if (!copied.ok || !copied.buf.equals(bytes)) refuse('COPY-READBACK');
  }
  console.log('STAGE-OK');
} catch (error) {
  for (const entry of owned.reverse()) {
    try {
      const st = lstatSync(entry.target);
      if (st.dev === entry.dev && st.ino === entry.ino && st.isFile()) unlinkSync(entry.target);
    } catch {}
  }
  const allowed = ['USAGE', 'DESTINATION-TYPE', 'SOURCE-INDEX', 'SOURCE-SHAPE', 'SOURCE-META', 'SOURCE-PROVENANCE', 'COPY-READBACK'];
  console.error(allowed.includes(error.message) ? error.message : 'STAGE-IO');
  process.exitCode = 1;
}
