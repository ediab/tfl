"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bus, RefreshCw, MapPin } from "lucide-react";

interface BusStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  indicator: string;
}

interface BusArrival {
  id: string;
  lineName: string;
  lineId: string;
  destinationName: string;
  towards: string;
  timeToStation: number;
}

interface RouteGroup {
  routeId: string;
  routeName: string;
  arrivals: BusArrival[];
}

const MAX_PER_ROUTE = 5;
const BUS_RED = "#C00000";
const ROW_OPACITY = [1, 0.75, 0.55, 0.4, 0.3];
const LS_BUS_STOP = "tfl:bus-stop";

function formatEta(seconds: number): string {
  if (seconds < 60) return "due";
  return `${Math.floor(seconds / 60)} min`;
}

function groupByRoute(arrivals: BusArrival[]): RouteGroup[] {
  const map = new Map<string, { routeName: string; arrivals: BusArrival[] }>();
  for (const a of arrivals) {
    if (!map.has(a.lineId)) map.set(a.lineId, { routeName: a.lineName, arrivals: [] });
    map.get(a.lineId)!.arrivals.push(a);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([routeId, { routeName, arrivals }]) => ({
      routeId,
      routeName,
      arrivals: arrivals.slice(0, MAX_PER_ROUTE),
    }));
}

function BusArrivalsBoard({ stop }: { stop: BusStop }) {
  const [arrivals, setArrivals] = useState<BusArrival[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchArrivals = useCallback(async () => {
    try {
      const res = await fetch(`/api/bus-arrivals/${stop.id}`);
      if (!res.ok) throw new Error(`TfL API error ${res.status}`);
      const data: BusArrival[] = await res.json();
      setArrivals(
        data.filter((a) => a.timeToStation >= 0).sort((a, b) => a.timeToStation - b.timeToStation),
      );
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch arrivals");
    } finally {
      setLoading(false);
    }
  }, [stop.id]);

  useEffect(() => {
    fetchArrivals();
    intervalRef.current = setInterval(fetchArrivals, 30_000);

    function handleVisibility() {
      if (document.hidden) {
        if (intervalRef.current) clearInterval(intervalRef.current);
      } else {
        fetchArrivals();
        intervalRef.current = setInterval(fetchArrivals, 30_000);
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchArrivals]);

  const groups = groupByRoute(arrivals);
  const stopLabel = stop.name + (stop.indicator ? ` · ${stop.indicator}` : "");

  return (
    <div className="border border-neutral-200 dark:border-neutral-800 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40">
        <div className="flex items-center gap-2">
          <MapPin size={12} className="text-neutral-400 dark:text-neutral-700" />
          <span className="text-xs font-mono text-neutral-500 tracking-wide">{stopLabel}</span>
        </div>
        {lastUpdated && (
          <span className="text-[10px] font-mono text-neutral-400 dark:text-neutral-700 tabular-nums">
            {lastUpdated.toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-10 gap-2 text-neutral-400 dark:text-neutral-700">
          <RefreshCw size={12} className="animate-spin" />
          <span className="text-xs font-mono">fetching arrivals…</span>
        </div>
      )}

      {error && !loading && (
        <div className="px-4 py-6 text-xs font-mono text-red-600 dark:text-red-500 text-center">
          {error}
        </div>
      )}

      {!loading && !error && arrivals.length === 0 && (
        <div className="px-4 py-6 text-xs font-mono text-neutral-400 dark:text-neutral-700 text-center">
          no arrivals in the next few minutes
        </div>
      )}

      {!loading && groups.length > 0 && (
        <div>
          {groups.map((route, ri) => (
            <div
              key={route.routeId}
              className={ri > 0 ? "border-t border-neutral-200 dark:border-neutral-800" : ""}
            >
              <div className="flex items-center px-4 py-2" style={{ backgroundColor: BUS_RED }}>
                <span className="text-[10px] font-mono text-white uppercase tracking-[0.18em]">
                  {route.routeName}
                </span>
              </div>
              <ul>
                {route.arrivals.map((a, i) => {
                  const isDue = a.timeToStation < 60;
                  return (
                    <li
                      key={a.id}
                      className={`flex items-center px-4 py-2 ${
                        i !== route.arrivals.length - 1
                          ? "border-b border-neutral-200/30 dark:border-neutral-800/30"
                          : ""
                      }`}
                      style={{ opacity: ROW_OPACITY[i] ?? 0.25 }}
                    >
                      <span className="flex-1 min-w-0 text-sm font-mono text-neutral-900 dark:text-neutral-200 truncate">
                        {a.towards || a.destinationName}
                      </span>
                      <span
                        className={`text-sm font-mono tabular-nums shrink-0 w-14 text-right ${
                          isDue
                            ? "text-amber-500 dark:text-amber-400 font-semibold"
                            : "text-neutral-500"
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
      )}
    </div>
  );
}

export default function BusesTab() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BusStop[]>([]);
  const [selectedStop, setSelectedStop] = useState<BusStop | null>(null);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore last selected stop from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_BUS_STOP);
      if (saved) setSelectedStop(JSON.parse(saved));
    } catch {}
  }, []);

  // Persist selected stop
  useEffect(() => {
    try {
      if (selectedStop) localStorage.setItem(LS_BUS_STOP, JSON.stringify(selectedStop));
      else localStorage.removeItem(LS_BUS_STOP);
    } catch {}
  }, [selectedStop]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/bus-stops/search?q=${encodeURIComponent(q)}`);
        if (res.ok) setResults(await res.json());
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function selectStop(stop: BusStop) {
    setSelectedStop(stop);
    setQuery("");
    setResults([]);
  }

  function clearStop() {
    setSelectedStop(null);
    setQuery("");
    setResults([]);
  }

  return (
    <div>
      {selectedStop ? (
        <>
          <div className="mb-3">
            <button
              onClick={clearStop}
              className="text-[10px] font-mono text-neutral-400 dark:text-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-300 uppercase tracking-widest transition-colors"
            >
              ← change stop
            </button>
          </div>
          <BusArrivalsBoard key={selectedStop.id} stop={selectedStop} />
        </>
      ) : (
        <>
          <div className="border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 mb-3">
            <div className="flex items-center gap-2.5 px-3.5">
              <Bus size={12} className="text-neutral-400 dark:text-neutral-700 shrink-0" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="type a bus stop name…"
                className="flex-1 bg-transparent py-3 font-mono text-neutral-800 dark:text-neutral-300 placeholder-neutral-300 dark:placeholder-neutral-700 outline-none"
                style={{ fontSize: "16px" }}
                autoComplete="off"
                autoFocus
              />
              {query && (
                <button
                  onClick={() => {
                    setQuery("");
                    setResults([]);
                  }}
                  className="text-neutral-400 dark:text-neutral-700 hover:text-neutral-600 dark:hover:text-neutral-500 text-[10px] font-mono uppercase tracking-widest"
                >
                  clear
                </button>
              )}
            </div>
          </div>

          {searching && (
            <div className="flex items-center gap-2 py-4 text-neutral-400 dark:text-neutral-700">
              <RefreshCw size={12} className="animate-spin" />
              <span className="text-xs font-mono">searching…</span>
            </div>
          )}

          {!searching && results.length > 0 && (
            <ul className="border border-neutral-200 dark:border-neutral-800 overflow-hidden">
              {results.map((stop) => (
                <li key={stop.id}>
                  <button
                    onClick={() => selectStop(stop)}
                    className="w-full text-left px-3.5 py-3 font-mono transition-colors border-b border-neutral-200/40 dark:border-neutral-800/40 last:border-0 min-h-[44px] flex items-center gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
                  >
                    {stop.indicator ? (
                      <span
                        className="text-[10px] font-mono text-white px-1.5 py-0.5 shrink-0 min-w-[3rem] text-center"
                        style={{ backgroundColor: BUS_RED }}
                      >
                        {stop.indicator}
                      </span>
                    ) : (
                      <span className="w-12 shrink-0" />
                    )}
                    <span className="text-sm text-neutral-800 dark:text-neutral-300 flex-1 truncate">
                      {stop.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!searching && query.trim() && results.length === 0 && (
            <p className="py-4 text-xs font-mono text-neutral-400 dark:text-neutral-700">
              no stops found
            </p>
          )}

          {!query.trim() && (
            <p className="py-8 text-xs font-mono text-neutral-400 dark:text-neutral-700 text-center">
              type to search for a bus stop
            </p>
          )}
        </>
      )}
    </div>
  );
}
