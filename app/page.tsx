"use client";

import { useEffect, useState, useCallback } from "react";
import { Train, RefreshCw, Clock, MapPin, Plus, X } from "lucide-react";
import { ALL_STATIONS, DEFAULT_STATION, lineColour } from "@/lib/stations";

interface Arrival {
  id: string;
  lineName: string;
  lineId: string;
  platformName: string;
  destinationName: string;
  timeToStation: number;
  towards: string;
}

interface Station {
  id: string;
  name: string;
}

const STORAGE_KEY = "tfl:stations";
const MAX_BOARDS = 4;

function formatEta(seconds: number): string {
  if (seconds < 60) return "due";
  const mins = Math.floor(seconds / 60);
  return `${mins} min${mins !== 1 ? "s" : ""}`;
}

function ArrivalsBoard({ stationId, stationName }: { stationId: string; stationName: string }) {
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchArrivals = useCallback(async () => {
    try {
      const res = await fetch(`https://api.tfl.gov.uk/StopPoint/${stationId}/Arrivals`);
      if (!res.ok) throw new Error(`TfL API error ${res.status}`);
      const data: Arrival[] = await res.json();
      const sorted = data
        .filter((a) => a.timeToStation >= 0)
        .sort((a, b) => a.timeToStation - b.timeToStation)
        .slice(0, 12);
      setArrivals(sorted);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch arrivals");
    } finally {
      setLoading(false);
    }
  }, [stationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchArrivals();
    const interval = setInterval(fetchArrivals, 30_000);
    return () => clearInterval(interval);
  }, [fetchArrivals]);

  return (
    <div className="border border-neutral-800 bg-neutral-900 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <MapPin size={14} className="text-neutral-500" />
          <span className="text-sm font-mono text-neutral-300 truncate max-w-xs">{stationName}</span>
        </div>
        {lastUpdated && (
          <span className="text-xs font-mono text-neutral-600">
            {lastUpdated.toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-10 gap-2 text-neutral-600">
          <RefreshCw size={14} className="animate-spin" />
          <span className="text-xs font-mono">Fetching arrivals…</span>
        </div>
      )}

      {error && !loading && (
        <div className="px-4 py-6 text-xs font-mono text-red-500 text-center">{error}</div>
      )}

      {!loading && !error && arrivals.length === 0 && (
        <div className="px-4 py-6 text-xs font-mono text-neutral-600 text-center">
          No arrivals in the next few minutes.
        </div>
      )}

      {!loading && arrivals.length > 0 && (
        <ul>
          {arrivals.map((arrival, i) => (
            <li
              key={arrival.id}
              className={`flex items-center gap-3 px-4 py-2.5 ${
                i !== arrivals.length - 1 ? "border-b border-neutral-800" : ""
              }`}
            >
              <span
                className="w-1.5 h-8 shrink-0"
                style={{ backgroundColor: lineColour(arrival.lineId) }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-mono text-neutral-500 uppercase tracking-wide">
                    {arrival.lineName}
                  </span>
                  <span className="text-sm text-neutral-200 truncate">
                    {arrival.towards || arrival.destinationName}
                  </span>
                </div>
                <span className="text-xs font-mono text-neutral-600">{arrival.platformName}</span>
              </div>
              <span
                className={`text-sm font-mono tabular-nums shrink-0 ${
                  arrival.timeToStation < 60 ? "text-amber-400" : "text-neutral-300"
                }`}
              >
                {formatEta(arrival.timeToStation)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Home() {
  const [selectedStations, setSelectedStations] = useState<Station[]>([DEFAULT_STATION]);
  const [hydrated, setHydrated] = useState(false);
  const [pickedId, setPickedId] = useState(DEFAULT_STATION.id);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Station[];
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every((s) => s && typeof s.id === "string" && typeof s.name === "string")
        ) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSelectedStations(parsed.slice(0, MAX_BOARDS));
        }
      }
    } catch {
      // ignore corrupt storage
    }
     
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedStations));
    } catch {
      // quota / private-mode
    }
  }, [selectedStations, hydrated]);

  function addStation() {
    const station = ALL_STATIONS.find((s) => s.id === pickedId);
    if (!station) return;
    setSelectedStations((prev) => {
      if (prev.length >= MAX_BOARDS) return prev;
      if (prev.some((s) => s.id === station.id)) return prev;
      return [...prev, station];
    });
  }

  function removeStation(id: string) {
    setSelectedStations((prev) => prev.filter((s) => s.id !== id));
  }

  const atMax = selectedStations.length >= MAX_BOARDS;
  const alreadyAdded = selectedStations.some((s) => s.id === pickedId);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Train size={20} className="text-neutral-500" />
          <h1 className="text-lg font-mono tracking-tight text-neutral-200">tfl arrivals</h1>
          <span className="text-xs font-mono text-neutral-700 ml-auto flex items-center gap-1">
            <Clock size={10} />
            30s refresh
          </span>
        </div>

        <div className="flex gap-2 mb-6">
          <select
            value={pickedId}
            onChange={(e) => setPickedId(e.target.value)}
            className="flex-1 bg-neutral-900 border border-neutral-800 text-sm font-mono text-neutral-300 px-3 py-2.5 outline-none appearance-none cursor-pointer hover:border-neutral-700 focus:border-neutral-600 transition-colors"
          >
            {ALL_STATIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            onClick={addStation}
            disabled={atMax || alreadyAdded}
            className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-mono border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Plus size={14} />
            Add
          </button>
        </div>

        <div className="space-y-4">
          {selectedStations.map((station) => (
            <div key={station.id}>
              <div className="flex justify-end mb-1">
                <button
                  onClick={() => removeStation(station.id)}
                  className="flex items-center gap-1 text-xs font-mono text-neutral-700 hover:text-neutral-500 transition-colors"
                >
                  <X size={10} />
                  remove
                </button>
              </div>
              <ArrivalsBoard key={station.id} stationId={station.id} stationName={station.name} />
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-xs font-mono text-neutral-800">
          data © tfl.gov.uk · open government licence
        </p>
      </div>
    </main>
  );
}
