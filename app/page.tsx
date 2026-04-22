"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Train, RefreshCw, MapPin, ChevronDown } from "lucide-react";
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

interface DirectionGroup {
  label: string;
  arrivals: Arrival[];
}

interface LineGroup {
  lineId: string;
  lineName: string;
  directions: DirectionGroup[];
}

const STORAGE_KEY = "tfl:stations";
const MAX_PER_DIRECTION = 5;
const DIR_ORDER = ["Northbound", "Southbound", "Eastbound", "Westbound", "Inner Rail", "Outer Rail"];

function formatEta(seconds: number): string {
  if (seconds < 60) return "due";
  const mins = Math.floor(seconds / 60);
  return `${mins} min`;
}

function extractDirection(platformName: string): string {
  const dash = platformName.indexOf(" - ");
  if (dash > 0) return platformName.slice(0, dash);
  for (const d of DIR_ORDER) {
    if (platformName.toLowerCase().includes(d.toLowerCase())) return d;
  }
  return platformName;
}

function groupArrivals(arrivals: Arrival[]): LineGroup[] {
  const lineMap = new Map<string, { lineName: string; dirMap: Map<string, Arrival[]> }>();
  for (const a of arrivals) {
    if (!lineMap.has(a.lineId)) lineMap.set(a.lineId, { lineName: a.lineName, dirMap: new Map() });
    const dir = extractDirection(a.platformName);
    const { dirMap } = lineMap.get(a.lineId)!;
    if (!dirMap.has(dir)) dirMap.set(dir, []);
    dirMap.get(dir)!.push(a);
  }
  return [...lineMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lineId, { lineName, dirMap }]) => ({
      lineId,
      lineName,
      directions: [...dirMap.entries()]
        .sort(([a], [b]) => {
          const ai = DIR_ORDER.indexOf(a);
          const bi = DIR_ORDER.indexOf(b);
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        })
        .map(([label, grpArrivals]) => ({
          label,
          arrivals: grpArrivals.slice(0, MAX_PER_DIRECTION),
        })),
    }));
}

const ROW_OPACITY = [1, 0.75, 0.55, 0.4, 0.3];

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
      setArrivals(
        data.filter((a) => a.timeToStation >= 0).sort((a, b) => a.timeToStation - b.timeToStation)
      );
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

  const groups = groupArrivals(arrivals);

  return (
    <div className="border border-neutral-800 overflow-hidden">
      {/* Board header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-800 bg-neutral-900/40">
        <div className="flex items-center gap-2">
          <MapPin size={12} className="text-neutral-700" />
          <span className="text-xs font-mono text-neutral-500 tracking-wide">{stationName}</span>
        </div>
        {lastUpdated && (
          <span className="text-[10px] font-mono text-neutral-700 tabular-nums">
            {lastUpdated.toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-10 gap-2 text-neutral-700">
          <RefreshCw size={12} className="animate-spin" />
          <span className="text-xs font-mono">fetching arrivals…</span>
        </div>
      )}

      {error && !loading && (
        <div className="px-4 py-6 text-xs font-mono text-red-600 text-center">{error}</div>
      )}

      {!loading && !error && arrivals.length === 0 && (
        <div className="px-4 py-6 text-xs font-mono text-neutral-700 text-center">
          no arrivals in the next few minutes
        </div>
      )}

      {!loading && groups.length > 0 && (
        <div>
          {groups.map((line, li) => (
            <div key={line.lineId} className={li > 0 ? "border-t border-neutral-800" : ""}>
              {/* Line header */}
              <div
                className="flex items-center px-4 py-2"
                style={{ borderLeft: `3px solid ${lineColour(line.lineId)}` }}
              >
                <span
                  className="text-[10px] font-mono uppercase tracking-[0.18em]"
                  style={{ color: lineColour(line.lineId), opacity: 0.85 }}
                >
                  {line.lineName}
                </span>
              </div>

              {/* Direction sections */}
              {line.directions.map((dir) => (
                <div key={dir.label}>
                  <div className="px-4 py-1 border-t border-neutral-800/50">
                    <span className="text-[9px] font-mono text-neutral-700 uppercase tracking-[0.14em]">
                      {dir.label}
                    </span>
                  </div>
                  <ul>
                    {dir.arrivals.map((a, i) => {
                      const isDue = a.timeToStation < 60;
                      return (
                        <li
                          key={a.id}
                          className={`flex items-center px-4 py-2 ${
                            i !== dir.arrivals.length - 1 ? "border-b border-neutral-800/30" : ""
                          }`}
                          style={{ opacity: ROW_OPACITY[i] ?? 0.25 }}
                        >
                          <span className="flex-1 min-w-0 text-sm font-mono text-neutral-200 truncate">
                            {a.towards || a.destinationName}
                          </span>
                          <span
                            className={`text-sm font-mono tabular-nums shrink-0 w-14 text-right ${
                              isDue ? "text-amber-400 font-semibold" : "text-neutral-500"
                            }`}
                          >
                            {formatEta(a.timeToStation)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [station, setStation] = useState<Station>(DEFAULT_STATION);
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const comboRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
        if (candidate?.id && typeof candidate.id === "string" && candidate?.name) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setStation(candidate as Station);
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(station));
    } catch {
      // quota / private-mode
    }
  }, [station, hydrated]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const filtered = query.trim()
    ? ALL_STATIONS.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    : ALL_STATIONS;

  function selectStation(s: Station) {
    setStation(s);
    setQuery("");
    setOpen(false);
  }

  return (
    <main
      className="min-h-dvh bg-neutral-950 text-neutral-100 px-4 md:px-8 pt-4 md:pt-8"
      style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}
    >
      <div className="max-w-2xl mx-auto">

        {/* App header */}
        <div className="flex items-center gap-2.5 mb-8">
          <Train size={16} className="text-neutral-600" />
          <h1 className="text-sm font-mono tracking-[0.12em] text-neutral-400 uppercase">
            tfl arrivals
          </h1>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-neutral-700 animate-pulse" />
            <span className="text-[10px] font-mono text-neutral-700 tracking-widest">30s</span>
          </div>
        </div>

        {/* Station picker */}
        <div className="relative mb-5" ref={comboRef}>
          <button
            onClick={() => { setOpen((o) => !o); setQuery(""); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 bg-neutral-900 border border-neutral-800 hover:border-neutral-700 transition-colors text-left"
          >
            <MapPin size={12} className="text-neutral-700 shrink-0" />
            <span className="flex-1 text-sm font-mono text-neutral-300 truncate">{station.name}</span>
            <ChevronDown
              size={12}
              className={`text-neutral-700 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            />
          </button>

          {open && (
            <div className="absolute left-0 right-0 z-20 border border-t-0 border-neutral-800 bg-neutral-900 shadow-2xl shadow-black">
              <div className="flex items-center gap-2 px-3.5 border-b border-neutral-800">
                <span className="text-[10px] font-mono text-neutral-700 uppercase tracking-widest">search</span>
                <input
                  autoFocus
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="type to filter…"
                  className="flex-1 bg-transparent py-2.5 font-mono text-neutral-300 placeholder-neutral-800 outline-none"
                  style={{ fontSize: "16px" }}
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="text-neutral-700 hover:text-neutral-500 text-[10px] font-mono uppercase tracking-widest"
                  >
                    clear
                  </button>
                )}
              </div>
              <ul className="max-h-60 overflow-y-auto">
                {filtered.map((s) => (
                  <li key={s.id}>
                    <button
                      onClick={() => selectStation(s)}
                      className={`w-full text-left px-3.5 py-3 text-sm font-mono border-b border-neutral-800/40 last:border-0 transition-colors min-h-[44px] flex items-center ${
                        s.id === station.id
                          ? "text-neutral-100 bg-neutral-800"
                          : "text-neutral-500 hover:bg-neutral-800/50 hover:text-neutral-200"
                      }`}
                    >
                      {s.name}
                    </button>
                  </li>
                ))}
                {filtered.length === 0 && (
                  <li className="px-3.5 py-3 text-[11px] font-mono text-neutral-700">no stations found</li>
                )}
              </ul>
            </div>
          )}
        </div>

        <ArrivalsBoard key={station.id} stationId={station.id} stationName={station.name} />

        <p className="mt-8 text-center text-[10px] font-mono text-neutral-800 tracking-widest uppercase">
          data © tfl.gov.uk · open government licence
        </p>
      </div>
    </main>
  );
}
