import type { Coordinates } from "@/lib/nearest-stations";

type HeaderBag = Pick<Headers, "get">;

interface IpApiResponse {
  error?: boolean;
  reserved?: boolean;
  latitude?: number | string;
  longitude?: number | string;
}

function parseCoordinate(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCoordinatesFromHeaders(headers: HeaderBag): Coordinates | null {
  const pairs: Array<[string, string]> = [
    ["x-vercel-ip-latitude", "x-vercel-ip-longitude"],
    ["cf-iplatitude", "cf-iplongitude"],
  ];

  for (const [latHeader, lonHeader] of pairs) {
    const lat = parseCoordinate(headers.get(latHeader));
    const lon = parseCoordinate(headers.get(lonHeader));
    if (lat !== null && lon !== null) return { lat, lon };
  }

  return null;
}

function extractForwardedIp(value: string | null): string | null {
  if (!value) return null;

  const first = value.split(",")[0]?.trim();
  if (!first) return null;

  if (first.includes(".")) {
    const ipv4 = first.match(/\d{1,3}(?:\.\d{1,3}){3}/);
    if (ipv4) return ipv4[0];
  }

  const withoutPrefix = first.replace(/^for=/i, "").replace(/^"|"$/g, "");
  if (withoutPrefix.startsWith("[")) {
    const closingIndex = withoutPrefix.indexOf("]");
    if (closingIndex > 1) return withoutPrefix.slice(1, closingIndex);
  }

  return withoutPrefix;
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase();

  if (normalized === "localhost" || normalized === "::1" || normalized.startsWith("::ffff:127.")) {
    return true;
  }

  if (
    normalized.startsWith("10.") ||
    normalized.startsWith("127.") ||
    normalized.startsWith("192.168.") ||
    normalized.startsWith("169.254.")
  ) {
    return true;
  }

  if (normalized.startsWith("172.")) {
    const secondOctet = Number(normalized.split(".")[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }

  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function readClientIp(headers: HeaderBag): string | null {
  const candidates = [
    headers.get("x-forwarded-for"),
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    headers.get("forwarded"),
  ];

  for (const candidate of candidates) {
    const ip = extractForwardedIp(candidate);
    if (ip && !isPrivateIp(ip)) return ip;
  }

  return null;
}

async function lookupCoordinatesByIp(ip: string): Promise<Coordinates | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  let response: Response;
  try {
    response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "tfl-diab-station-locator/1.0",
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) return null;

  const data = (await response.json()) as IpApiResponse;
  if (data.error || data.reserved) return null;

  const lat = parseCoordinate(data.latitude);
  const lon = parseCoordinate(data.longitude);

  return lat !== null && lon !== null ? { lat, lon } : null;
}

export async function resolveRequestCoordinates(headers: HeaderBag): Promise<Coordinates | null> {
  const headerCoordinates = readCoordinatesFromHeaders(headers);
  if (headerCoordinates) return headerCoordinates;

  const ip = readClientIp(headers);
  if (!ip) return null;

  try {
    return await lookupCoordinatesByIp(ip);
  } catch {
    return null;
  }
}
