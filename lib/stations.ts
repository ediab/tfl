export const LINE_COLOURS: Record<string, string> = {
  bakerloo: "#B36305",
  central: "#E32017",
  circle: "#FFD300",
  district: "#00782A",
  "hammersmith-city": "#F3A9BB",
  jubilee: "#A0A5A9",
  metropolitan: "#9B0056",
  northern: "#000000",
  piccadilly: "#003688",
  victoria: "#0098D4",
  "waterloo-city": "#95CDBA",
  elizabeth: "#6950a8",
  overground: "#EE7C0E",
  dlr: "#00A4A7",
};

export const PRESET_STATIONS: { id: string; name: string }[] = [
  { id: "940GZZLUKSX", name: "King's Cross St. Pancras" },
  { id: "940GZZLULVT", name: "Liverpool Street" },
  { id: "940GZZLUVIC", name: "Victoria" },
  { id: "940GZZLUOXC", name: "Oxford Circus" },
  { id: "940GZZLUBNK", name: "Bank" },
  { id: "940GZZLUCWR", name: "Canary Wharf" },
  { id: "940GZZLUWLO", name: "Waterloo" },
  { id: "940GZZLUGPK", name: "Green Park" },
];

export function lineColour(lineId: string): string {
  return LINE_COLOURS[lineId.toLowerCase()] ?? "#6b7280";
}
