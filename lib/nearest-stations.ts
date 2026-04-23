import { ALL_STATIONS, type Station } from "@/lib/stations";

export interface Coordinates {
  lat: number;
  lon: number;
}

const LONDON_CENTER: Coordinates = { lat: 51.5074, lon: -0.1278 };
const LONDON_CATCHMENT_RADIUS_METERS = 90_000;

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function distanceBetween(a: Coordinates, b: Coordinates): number {
  const earthRadiusMeters = 6_371_000;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function isWithinLondonCatchment(coords: Coordinates): boolean {
  return distanceBetween(coords, LONDON_CENTER) <= LONDON_CATCHMENT_RADIUS_METERS;
}

export function getNearestStations(coords: Coordinates, count: number): Station[] {
  return ALL_STATIONS.map((station) => ({
    station,
    distance: distanceBetween(coords, station),
  }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count)
    .map(({ station }) => station);
}
