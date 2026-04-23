import { readFileSync } from "fs";
import { join } from "path";
import { type NextRequest } from "next/server";

// Mirrors the static file loaded by the search route — same module-level cache pattern
let STOP_IDS: Set<string> | null = null;
try {
  const stops: { id: string }[] = JSON.parse(
    readFileSync(join(process.cwd(), "lib/bus-stops.json"), "utf-8"),
  );
  if (stops.length > 0) STOP_IDS = new Set(stops.map((s) => s.id));
} catch {
  // File absent — fall back to format-based validation
}

// London bus stop NaPTAN IDs: "490" prefix, 8–16 alphanumeric chars
const BUS_NAPTAN_RE = /^490[0-9A-Z]{5,13}$/i;

function isValidBusStop(id: string): boolean {
  if (STOP_IDS) return STOP_IDS.has(id);
  return BUS_NAPTAN_RE.test(id);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ naptanId: string }> },
) {
  const { naptanId } = await params;

  if (!isValidBusStop(naptanId)) {
    return new Response("Invalid stop", { status: 400 });
  }

  const url = new URL(`https://api.tfl.gov.uk/StopPoint/${naptanId}/Arrivals`);
  const apiKey = process.env.TFL_API_KEY;
  if (apiKey) url.searchParams.set("app_key", apiKey);

  const res = await fetch(url.toString(), { next: { revalidate: 20 } });
  if (!res.ok) return new Response("TfL API error", { status: res.status });

  return Response.json(await res.json(), {
    headers: { "Cache-Control": "public, max-age=20, stale-while-revalidate=10" },
  });
}
