import { type NextRequest } from "next/server";
import { ALL_STATIONS } from "@/lib/stations";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ naptanId: string }> },
) {
  const { naptanId } = await params;

  // Whitelist against known stations to prevent SSRF
  if (!ALL_STATIONS.some((s) => s.id === naptanId)) {
    return new Response("Invalid station", { status: 400 });
  }

  const url = new URL(`https://api.tfl.gov.uk/StopPoint/${naptanId}/Arrivals`);
  const apiKey = process.env.TFL_API_KEY;
  if (apiKey) url.searchParams.set("app_key", apiKey);

  const res = await fetch(url.toString(), { next: { revalidate: 20 } });
  if (!res.ok) {
    return new Response("TfL API error", { status: res.status });
  }

  const data = await res.json();
  return Response.json(data, {
    headers: { "Cache-Control": "public, max-age=20, stale-while-revalidate=10" },
  });
}
