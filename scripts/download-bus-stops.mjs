#!/usr/bin/env node
// Run once to populate lib/bus-stops.json
// Usage: TFL_API_KEY=xxx node scripts/download-bus-stops.mjs
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.TFL_API_KEY ?? "";
const BASE = "https://api.tfl.gov.uk";

async function fetchPage(page) {
  const url = new URL(`${BASE}/StopPoint/Mode/bus`);
  url.searchParams.set("page", String(page));
  if (API_KEY) url.searchParams.set("app_key", API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

const stops = [];
let page = 1;

while (true) {
  process.stdout.write(`  page ${page}... `);
  const data = await fetchPage(page);
  const sp = data.stopPoints ?? [];
  const total = data.total ?? 0;
  const pageSize = data.pageSize ?? 1000;

  for (const s of sp) {
    stops.push({
      id: s.naptanId,
      name: s.commonName,
      lat: s.lat,
      lon: s.lon,
      indicator: s.indicator ?? "",
    });
  }
  process.stdout.write(`${sp.length} stops (total: ${total}, fetched so far: ${stops.length})\n`);

  if (sp.length === 0 || page * pageSize >= total) break;
  page++;
  await new Promise((r) => setTimeout(r, 250));
}

stops.sort((a, b) => a.name.localeCompare(b.name));
console.log(`\nTotal bus stops: ${stops.length}`);

writeFileSync(join(__dir, "../lib/bus-stops.json"), JSON.stringify(stops));
console.log("Written to lib/bus-stops.json");
