"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Train, RefreshCw, MapPin, ChevronDown, Sun, Moon } from "lucide-react";
import { ALL_STATIONS, lineColour, type Station } from "@/lib/stations";
import { getNearestStations, isWithinLondonCatchment } from "@/lib/nearest-stations";

interface Arrival {
  id: string;
  lineName: string;
  lineId: string;
  platformName: string;
  destinationName: string;
  timeToStation: number;
  towards: string;
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

const MAX_PER_DIRECTION = 5;
const DIR_ORDER = [
  "Northbound",
  "Southbound",
  "Eastbound",
  "Westbound",
  "Inner Rail",
  "Outer Rail",
];
const LISTBOX_ID = "station-listbox";
const LS_KEY = "tfl:station";
const LS_THEME = "tfl:theme";

function formatEta(seconds: number): string {
  if (seconds < 60) return "due";
  return `${Math.floor(seconds / 60)} min`;
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
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchArrivals = useCallback(async () => {
    try {
      const res = await fetch(`/api/arrivals/${stationId}`);
      if (!res.ok) throw new Error(`TfL API error ${res.status}`);
      const data: Arrival[] = await res.json();
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
  }, [stationId]);

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

  const groups = useMemo(() => groupArrivals(arrivals), [arrivals]);

  return (
    <div className="border border-neutral-200 dark:border-neutral-800 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40">
        <div className="flex items-center gap-2">
          <MapPin size={12} className="text-neutral-400 dark:text-neutral-700" />
          <span className="text-xs font-mono text-neutral-500 tracking-wide">{stationName}</span>
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
        <div className="px-4 py-6 text-xs font-mono text-red-600 dark:text-red-500 text-center">{error}</div>
      )}

      {!loading && !error && arrivals.length === 0 && (
        <div className="px-4 py-6 text-xs font-mono text-neutral-400 dark:text-neutral-700 text-center">
          no arrivals in the next few minutes
        </div>
      )}

      {!loading && groups.length > 0 && (
        <div>
          {groups.map((line, li) => (
            <div key={line.lineId} className={li > 0 ? "border-t border-neutral-200 dark:border-neutral-800" : ""}>
              <div
                className="flex items-center px-4 py-2"
                style={{ borderLeft: `3px solid ${lineColour(line.lineId)}` }}
              >
                <span
                  className="text-[10px] font-mono uppercase tracking-[0.18em]"
                  style={{ color: lineColour(line.lineId) }}
                >
                  {line.lineName}
                </span>
              </div>

              {line.directions.map((dir) => (
                <div key={dir.label}>
                  <div className="px-4 py-1 border-t border-neutral-200/50 dark:border-neutral-800/50">
                    <span className="text-[9px] font-mono text-neutral-500 dark:text-neutral-400 uppercase tracking-[0.14em]">
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
                            i !== dir.arrivals.length - 1 ? "border-b border-neutral-200/30 dark:border-neutral-800/30" : ""
                          }`}
                          style={{ opacity: ROW_OPACITY[i] ?? 0.25 }}
                        >
                          <span className="flex-1 min-w-0 text-sm font-mono text-neutral-900 dark:text-neutral-200 truncate">
                            {a.towards || a.destinationName}
                          </span>
                          <span
                            className={`text-sm font-mono tabular-nums shrink-0 w-14 text-right ${
                              isDue ? "text-amber-500 dark:text-amber-400 font-semibold" : "text-neutral-500"
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

export default function HomeClient({
  initialStation,
  suggestedStations: initialSuggestedStations,
}: {
  initialStation: Station;
  suggestedStations: Station[];
}) {
  const [station, setStation] = useState<Station>(initialStation);
  const [suggestedStations, setSuggestedStations] = useState<Station[]>(initialSuggestedStations);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isDark, setIsDark] = useState(true);
  const comboRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const userSelected = useRef(false);

  // Sync theme state with the class already set by the anti-FOUC script
  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  // Watch system preference and auto-update when no manual override is stored
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function handler(e: MediaQueryListEvent) {
      try {
        if (!localStorage.getItem(LS_THEME)) applyTheme(e.matches);
      } catch {
        applyTheme(e.matches);
      }
    }
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  function applyTheme(dark: boolean) {
    document.documentElement.classList.toggle("dark", dark);
    setIsDark(dark);
  }

  function toggleTheme() {
    const next = !isDark;
    applyTheme(next);
    try {
      localStorage.setItem(LS_THEME, next ? "dark" : "light");
    } catch {}
  }

  // Restore last selected station from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved && !userSelected.current) {
        const found = ALL_STATIONS.find((s) => s.id === saved);
        if (found) setStation(found);
      }
    } catch {}
  }, []);

  // Persist selected station
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, station.id);
    } catch {}
  }, [station]);

  // Client-side geolocation (overrides localStorage if user hasn't manually picked)
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (userSelected.current) return;
        const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        if (!isWithinLondonCatchment(coords)) return;
        const nearest = getNearestStations(coords, 4);
        setStation(nearest[0]);
        setSuggestedStations(nearest.slice(1));
      },
      undefined,
      { timeout: 8000, maximumAge: 60_000 },
    );
  }, []);

  // Close dropdown on outside click/touch
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Reset keyboard cursor when query changes or dropdown closes
  useEffect(() => setActiveIndex(-1), [query]);
  useEffect(() => {
    if (!open) setActiveIndex(-1);
  }, [open]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      (listRef.current.children[activeIndex] as HTMLElement)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const filtered = useMemo(
    () =>
      query.trim()
        ? ALL_STATIONS.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
        : ALL_STATIONS,
    [query],
  );

  function selectStation(next: Station) {
    userSelected.current = true;
    setStation(next);
    setQuery("");
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0 && filtered[activeIndex]) selectStation(filtered[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setQuery("");
        break;
    }
  }

  return (
    <main
      className="min-h-dvh bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 px-4 md:px-8 pt-4 md:pt-8"
      style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}
    >
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-2.5 mb-8">
          <Train size={16} className="text-neutral-400 dark:text-neutral-600" />
          <h1 className="text-sm font-mono tracking-[0.12em] text-neutral-500 dark:text-neutral-400 uppercase">
            tfl arrivals
          </h1>
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-neutral-400 dark:bg-neutral-700 animate-pulse" />
              <span className="text-[10px] font-mono text-neutral-400 dark:text-neutral-700 tracking-widest">30s</span>
            </div>
            <button
              onClick={toggleTheme}
              aria-label="Toggle light/dark theme"
              className="text-neutral-400 dark:text-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
            >
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </div>

        <div className="relative mb-3" ref={comboRef}>
          <button
            onClick={() => {
              setOpen((was) => !was);
              setQuery("");
            }}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={LISTBOX_ID}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 transition-colors text-left"
          >
            <MapPin size={12} className="text-neutral-400 dark:text-neutral-700 shrink-0" />
            <span className="flex-1 text-sm font-mono text-neutral-800 dark:text-neutral-300 truncate">
              {station.name}
            </span>
            <ChevronDown
              size={12}
              className={`text-neutral-400 dark:text-neutral-700 shrink-0 transition-transform duration-150 ${
                open ? "rotate-180" : ""
              }`}
            />
          </button>

          {open && (
            <div className="absolute left-0 right-0 z-20 border border-t-0 border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl shadow-black/10 dark:shadow-black">
              <div className="flex items-center gap-2 px-3.5 border-b border-neutral-200 dark:border-neutral-800">
                <span className="text-[10px] font-mono text-neutral-400 dark:text-neutral-700 uppercase tracking-widest">
                  search
                </span>
                <input
                  autoFocus
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={open}
                  aria-controls={LISTBOX_ID}
                  aria-activedescendant={
                    activeIndex >= 0
                      ? `station-option-${filtered[activeIndex]?.id}`
                      : undefined
                  }
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="type to filter…"
                  className="flex-1 bg-transparent py-2.5 font-mono text-neutral-800 dark:text-neutral-300 placeholder-neutral-300 dark:placeholder-neutral-700 outline-none"
                  style={{ fontSize: "16px" }}
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="text-neutral-400 dark:text-neutral-700 hover:text-neutral-600 dark:hover:text-neutral-500 text-[10px] font-mono uppercase tracking-widest"
                  >
                    clear
                  </button>
                )}
              </div>
              <ul
                ref={listRef}
                id={LISTBOX_ID}
                role="listbox"
                aria-label="Stations"
                className="max-h-60 overflow-y-auto"
              >
                {filtered.map((s, i) => (
                  <li key={s.id} role="presentation">
                    <button
                      id={`station-option-${s.id}`}
                      role="option"
                      aria-selected={s.id === station.id}
                      onClick={() => selectStation(s)}
                      className={`w-full text-left px-3.5 py-3 text-sm font-mono border-b border-neutral-200/40 dark:border-neutral-800/40 last:border-0 transition-colors min-h-[44px] flex items-center ${
                        i === activeIndex
                          ? "bg-neutral-100 dark:bg-neutral-700/60 text-neutral-900 dark:text-neutral-100"
                          : s.id === station.id
                            ? "text-neutral-900 dark:text-neutral-100 bg-neutral-100 dark:bg-neutral-800"
                            : "text-neutral-600 dark:text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 hover:text-neutral-800 dark:hover:text-neutral-200"
                      }`}
                    >
                      {s.name}
                    </button>
                  </li>
                ))}
                {filtered.length === 0 && (
                  <li className="px-3.5 py-3 text-[11px] font-mono text-neutral-400 dark:text-neutral-700">
                    no stations found
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>

        {suggestedStations.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-mono text-neutral-400 dark:text-neutral-700 uppercase tracking-[0.18em]">
              nearby
            </span>
            {suggestedStations.map((s) => (
              <button
                key={s.id}
                onClick={() => selectStation(s)}
                className={`px-2.5 py-1.5 border text-xs font-mono transition-colors ${
                  s.id === station.id
                    ? "border-neutral-400 dark:border-neutral-500 bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                    : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-500 hover:border-neutral-300 dark:hover:border-neutral-700 hover:text-neutral-800 dark:hover:text-neutral-200"
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        <ArrivalsBoard key={station.id} stationId={station.id} stationName={station.name} />

        <p className="mt-8 text-center text-[10px] font-mono text-neutral-300 dark:text-neutral-800 tracking-widest uppercase">
          data © tfl.gov.uk · open government licence
        </p>
      </div>
    </main>
  );
}
