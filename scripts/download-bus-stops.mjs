#!/usr/bin/env node
// Run once to populate lib/bus-stops.json
// Usage: TFL_API_KEY=xxx node scripts/download-bus-stops.mjs
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.TFL_API_KEY ?? "";
const BASE = "https://api.tfl.gov.uk";

async function fetchPage(lat, lon, radius, page) {
  const url = new URL(`${BASE}/StopPoint`);
  url.searchParams.set("stopTypes", "NaptanPublicBusCoachTram");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("radius", String(radius));
  url.searchParams.set("useStopPointHierarchy", "false");
  url.searchParams.set("returnLines", "false");
  url.searchParams.set("page", String(page));
  if (API_KEY) url.searchParams.set("app_key", API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// 5-point cross pattern covering Greater London, each 22 km radius
const CENTRES = [
  [51.5074, -0.1278], // Central London
  [51.6300, -0.2800], // NW (Harrow/Wembley area)
  [51.6300,  0.0800], // NE (Tottenham/Walthamstow area)
  [51.3800, -0.2800], // SW (Sutton/Wimbledon area)
  [51.3800,  0.0800], // SE (Bromley/Croydon area)
];
const RADIUS = 22000;

const seen = new Set();
const stops = [];

for (const [lat, lon] of CENTRES) {
  let page = 0;
  process.stdout.write(`Querying [${lat}, ${lon}]...\n`);

  while (true) {
    process.stdout.write(`  page ${page}... `);
    const data = await fetchPage(lat, lon, RADIUS, page);
    const sp = data.stopPoints ?? [];
    const total = data.total ?? sp.length;
    const pageSize = data.pageSize ?? 100;

    for (const s of sp) {
      if (!seen.has(s.naptanId)) {
        seen.add(s.naptanId);
        stops.push({
          id: s.naptanId,
          name: s.commonName,
          lat: s.lat,
          lon: s.lon,
          indicator: s.indicator ?? "",
        });
      }
    }
    process.stdout.write(`${sp.length} stops (total: ${total}, unique so far: ${stops.length})\n`);

    if (sp.length === 0 || (page + 1) * pageSize >= total) break;
    page++;
    await new Promise((r) => setTimeout(r, 250));
  }
}

stops.sort((a, b) => a.name.localeCompare(b.name));
console.log(`\nTotal unique bus stops: ${stops.length}`);

writeFileSync(join(__dir, "../lib/bus-stops.json"), JSON.stringify(stops));
console.log("Written to lib/bus-stops.json");
