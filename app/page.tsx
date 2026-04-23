export const dynamic = "force-static";

import HomeClient from "@/app/home-client";
import { DEFAULT_STATION } from "@/lib/stations";

export default function Page() {
  return <HomeClient initialStation={DEFAULT_STATION} suggestedStations={[]} />;
}
