import { headers } from "next/headers";
import HomeClient from "@/app/home-client";
import { DEFAULT_STATION } from "@/lib/stations";
import { getNearestStations, isWithinLondonCatchment } from "@/lib/nearest-stations";
import { resolveRequestCoordinates } from "@/lib/request-geo";

export default async function Page() {
  const headerList = await headers();
  const coords = await resolveRequestCoordinates(headerList);
  const nearestStations =
    coords && isWithinLondonCatchment(coords) ? getNearestStations(coords, 4) : [];

  return (
    <HomeClient
      key={(nearestStations[0] ?? DEFAULT_STATION).id}
      initialStation={nearestStations[0] ?? DEFAULT_STATION}
      suggestedStations={nearestStations.slice(1)}
    />
  );
}
