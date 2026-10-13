#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { META_FORMAT, API_BASE, sha256OfBytes } from './lib/bus-stops-schema.mjs';
const script = join(dirname(fileURLToPath(import.meta.url)), 'stage-bus-index.mjs');
const root = mkdtempSync(join(tmpdir(), 'tfl-stage-test-'));
let pass = 0;
function fixture(name) {
  const dir = join(root, name); mkdirSync(dir);
  const dest = join(dir, 'output'); mkdirSync(dest);
  const index = Buffer.from(JSON.stringify([{ id: '4900001', name: 'Synthetic stop', lat: 51.5, lon: -0.1, indicator: 'A' }]));
  const meta = { format: META_FORMAT, generator: 'synthetic-stage-fixture', generatedAt: '2026-10-13T00:00:00.000Z', source: API_BASE, keyUsed: false, pages: 1, records: 1, bytes: index.length, sha256: sha256OfBytes(index) };
  const src = join(dir, 'bus-stops.json'); writeFileSync(src, index);
  writeFileSync(join(dir, 'bus-stops.meta.json'), JSON.stringify(meta));
  return { dir, dest, src, index, meta };
}
function run(f) { return spawnSync(process.execPath, [script, f.src, f.dest], { timeout: 3000, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, TMPDIR: root } }); }
function refused(f) { const r = run(f); assert.equal(r.status, 1, r.stderr); assert.equal(existsSync(join(f.dest, 'bus-stops.json')), false); pass++; }
try {
  let f = fixture('valid'); let r = run(f); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(join(f.dest, 'bus-stops.json')), f.index);
  assert.equal(readFileSync(join(f.dest, 'bus-stops.meta.json'), 'utf8'), JSON.stringify(f.meta)); pass++;
  f = fixture('unknown'); rmSync(join(f.dir, 'bus-stops.meta.json')); refused(f);
  f = fixture('tampered'); writeFileSync(f.src, Buffer.from('[]')); refused(f);
  f = fixture('synthetic-source'); f.meta.source = 'http://127.0.0.1/StopPoint/Mode/bus'; writeFileSync(join(f.dir, 'bus-stops.meta.json'), JSON.stringify(f.meta)); refused(f);
  f = fixture('source-link'); const other = join(f.dir, 'other.json'); writeFileSync(other, f.index); rmSync(f.src); symlinkSync(other, f.src); refused(f);
  f = fixture('destination-link'); rmSync(f.dest, { recursive: true }); mkdirSync(join(f.dir, 'elsewhere')); symlinkSync(join(f.dir, 'elsewhere'), f.dest); refused(f);
  f = fixture('existing-index'); writeFileSync(join(f.dest, 'bus-stops.json'), 'protected'); r = run(f); assert.equal(r.status, 1); assert.equal(readFileSync(join(f.dest, 'bus-stops.json'), 'utf8'), 'protected'); pass++;
  f = fixture('existing-sidecar'); writeFileSync(join(f.dest, 'bus-stops.meta.json'), 'protected'); refused(f); assert.equal(readFileSync(join(f.dest, 'bus-stops.meta.json'), 'utf8'), 'protected');
  f = fixture('fifo'); rmSync(f.src); assert.equal(spawnSync('mkfifo', [f.src]).status, 0); refused(f);
  console.log(`${pass}/9 native pair-staging CLI cases passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
