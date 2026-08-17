/** Geography helpers: detect location columns and normalise values to atlas ids. */

export type GeoKind = "us-state" | "us-county-fips" | "country" | "latitude" | "longitude";

const STATE_FIPS: Record<string, string> = {
  alabama: "01",
  alaska: "02",
  arizona: "04",
  arkansas: "05",
  california: "06",
  colorado: "08",
  connecticut: "09",
  delaware: "10",
  "district of columbia": "11",
  florida: "12",
  georgia: "13",
  hawaii: "15",
  idaho: "16",
  illinois: "17",
  indiana: "18",
  iowa: "19",
  kansas: "20",
  kentucky: "21",
  louisiana: "22",
  maine: "23",
  maryland: "24",
  massachusetts: "25",
  michigan: "26",
  minnesota: "27",
  mississippi: "28",
  missouri: "29",
  montana: "30",
  nebraska: "31",
  nevada: "32",
  "new hampshire": "33",
  "new jersey": "34",
  "new mexico": "35",
  "new york": "36",
  "north carolina": "37",
  "north dakota": "38",
  ohio: "39",
  oklahoma: "40",
  oregon: "41",
  pennsylvania: "42",
  "rhode island": "44",
  "south carolina": "45",
  "south dakota": "46",
  tennessee: "47",
  texas: "48",
  utah: "49",
  vermont: "50",
  virginia: "51",
  washington: "53",
  "west virginia": "54",
  wisconsin: "55",
  wyoming: "56",
  "puerto rico": "72",
};

const STATE_ABBR: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10",
  DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19",
  KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25", MI: "26", MN: "27",
  MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35",
  NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
  SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53",
  WV: "54", WI: "55", WY: "56", PR: "72",
};

export const STATE_NAME_BY_FIPS: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_FIPS).map(([name, fips]) => [
    fips,
    name.replace(/\b\w/g, (c) => c.toUpperCase()),
  ]),
);

/** Normalise a state name, USPS abbreviation, or FIPS code to a 2-digit state FIPS id. */
export function toStateFips(value: unknown): string | null {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (STATE_ABBR[upper]) return STATE_ABBR[upper] as string;
  const lower = raw.toLowerCase();
  if (STATE_FIPS[lower]) return STATE_FIPS[lower] as string;
  if (/^\d{1,2}$/.test(raw)) {
    const padded = raw.padStart(2, "0");
    return Object.values(STATE_ABBR).includes(padded) ? padded : null;
  }
  return null;
}

/** Normalise a county FIPS (4 or 5 digits) to the 5-digit atlas id. */
export function toCountyFips(value: unknown): string | null {
  const raw = `${value ?? ""}`.trim();
  if (!/^\d{4,5}$/.test(raw)) return null;
  return raw.padStart(5, "0");
}

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "united states of america",
  us: "united states of america",
  "united states": "united states of america",
  uk: "united kingdom",
  gb: "united kingdom",
  "great britain": "united kingdom",
  uae: "united arab emirates",
  "south korea": "south korea",
  "republic of korea": "south korea",
  russia: "russia",
  "russian federation": "russia",
  drc: "dem. rep. congo",
};

/** Loose country-name key used to match world-atlas feature names. */
export function countryKey(value: unknown): string {
  const raw = `${value ?? ""}`.trim().toLowerCase();
  return COUNTRY_ALIASES[raw] ?? raw;
}

const NAME_HINTS: { kind: GeoKind; test: RegExp }[] = [
  { kind: "latitude", test: /^(lat|latitude|y_?coord)$/i },
  { kind: "longitude", test: /^(lon|lng|long|longitude|x_?coord)$/i },
  { kind: "us-county-fips", test: /(county.*fips|fips.*county|county_?code)/i },
  { kind: "us-state", test: /(state|st_?abbr|province)/i },
  { kind: "country", test: /(country|nation|iso_?c)/i },
];

export type LocationCandidate = { column: string; kind: GeoKind; matchPct: number };

type ColumnLike = { name: string; sampleValues: string[] };

/**
 * Inspect column names and values to find usable location columns.
 * Runs once per parsed file; the result is cached on the dataset.
 */
export function detectLocationColumns(
  columns: ColumnLike[],
  rows: Record<string, unknown>[],
): LocationCandidate[] {
  const sample = rows.slice(0, 200);
  const found: LocationCandidate[] = [];

  for (const column of columns) {
    const values = sample
      .map((row) => row?.[column.name])
      .filter((v) => v !== null && v !== undefined && `${v}`.trim() !== "");
    if (!values.length) continue;

    const share = (fn: (v: unknown) => boolean) =>
      values.filter(fn).length / values.length;

    const stateShare = share((v) => toStateFips(v) !== null);
    const countyShare = share((v) => toCountyFips(v) !== null);
    const numericShare = share((v) => Number.isFinite(Number(v)));
    const inLatRange = share((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= -90 && n <= 90;
    });
    const inLngRange = share((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= -180 && n <= 180;
    });

    const hint = NAME_HINTS.find((h) => h.test.test(column.name))?.kind;

    if (stateShare > 0.6) found.push({ column: column.name, kind: "us-state", matchPct: stateShare });
    else if (countyShare > 0.6 && hint === "us-county-fips")
      found.push({ column: column.name, kind: "us-county-fips", matchPct: countyShare });
    else if (hint === "latitude" && numericShare > 0.8 && inLatRange > 0.8)
      found.push({ column: column.name, kind: "latitude", matchPct: inLatRange });
    else if (hint === "longitude" && numericShare > 0.8 && inLngRange > 0.8)
      found.push({ column: column.name, kind: "longitude", matchPct: inLngRange });
    else if (hint === "country") found.push({ column: column.name, kind: "country", matchPct: 1 });
  }

  return found.sort((a, b) => b.matchPct - a.matchPct);
}

export function describeLocationDetection(
  columns: ColumnLike[],
  candidates: LocationCandidate[],
): string {
  if (candidates.length)
    return candidates
      .map((c) => `"${c.column}" → ${c.kind}`)
      .join(", ");
  return `no location column found; checked ${columns.map((c) => `"${c.name}"`).join(", ")}`;
}
