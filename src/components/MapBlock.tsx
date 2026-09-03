import { scaleQuantize } from "d3-scale";
import { geoCentroid } from "d3-geo";
import { useEffect, useMemo, useState } from "react";
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
  ZoomableGroup,
} from "react-simple-maps";

import { countryKey, toCountyFips, toStateFips } from "@/lib/geo";
import { useBlockRows, type DataQuery } from "@/lib/ops/files-context";
import { cn } from "@/lib/utils";

export type MapLevel = "us-states" | "us-counties" | "world";

export type MapSpec = DataQuery & {
  type?: "map";
  title?: string;
  geography?: MapLevel;
  /** Alias accepted from the model. */
  level?: MapLevel;
  regionKey?: string;
  measure?: string;
  /** Optional single-country / region focus, e.g. "Kenya". */
  focus?: string;
  rows?: Record<string, unknown>[];
  points?: { lat?: number; lng?: number; label?: string; value?: number }[];
  note?: string;
};

const RAMPS: Record<string, string[]> = {
  Ocean: ["#0b3a4a", "#12657c", "#1c93a8", "#3fc0c8", "#8fe3e0"],
  Blues: ["#0f2f5c", "#1b4f96", "#2f76c9", "#63a4e8", "#a9cdf7"],
  Warm: ["#4a1d18", "#8a2f22", "#c4552c", "#e5893f", "#f6c177"],
  Viridis: ["#26313e", "#31688e", "#35b779", "#8fd744", "#fde725"],
};

const ATLASES: Record<MapLevel, () => Promise<unknown>> = {
  "us-states": () => import("us-atlas/states-10m.json"),
  "us-counties": () => import("us-atlas/counties-10m.json"),
  world: () => import("world-atlas/countries-110m.json"),
};

const numberFmt = (value: number) =>
  Math.abs(value) >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : `${Math.round(value * 100) / 100}`;

function useAtlas(level: MapLevel) {
  const [topology, setTopology] = useState<unknown>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setTopology(null);
    setFailed(null);
    const timeout = window.setTimeout(() => {
      if (alive) setFailed("The map outlines are taking unusually long to load.");
    }, 15_000);
    ATLASES[level]()
      .then((module) => {
        if (!alive) return;
        setTopology((module as { default?: unknown }).default ?? module);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setFailed(
          error instanceof Error
            ? `The map outlines could not be loaded (${error.message}).`
            : "The map outlines could not be loaded.",
        );
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [level]);
  return { topology, failed };
}

/** Normalise a row's region value to the id/name the atlas uses at this level. */
function regionId(level: MapLevel, value: unknown): string | null {
  if (level === "us-states") return toStateFips(value);
  if (level === "us-counties") return toCountyFips(value);
  const key = countryKey(value);
  return key || null;
}

function featureKey(level: MapLevel, geo: { id?: unknown; properties?: Record<string, unknown> }) {
  if (level === "world") return countryKey(geo.properties?.["name"]);
  return `${geo.id ?? ""}`;
}

export function MapBlock({ spec }: { spec: MapSpec }) {
  const rows: Record<string, unknown>[] = useBlockRows(spec.rows, spec, spec.measure, 4000);
  const points = useMemo(() => (Array.isArray(spec.points) ? spec.points : []), [spec.points]);

  const measures = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows.slice(0, 20))
      for (const [key, value] of Object.entries(row ?? {}))
        if (typeof value === "number" && Number.isFinite(value)) keys.add(key);
    return [...keys];
  }, [rows]);

  const regionKey = useMemo(() => {
    if (spec.regionKey && rows.some((row) => row?.[spec.regionKey as string] !== undefined))
      return spec.regionKey;
    const first = rows[0] ?? {};
    return (
      Object.keys(first).find((key) => typeof first[key] === "string") ??
      Object.keys(first)[0] ??
      "region"
    );
  }, [rows, spec.regionKey]);

  const [level, setLevel] = useState<MapLevel>(spec.geography ?? spec.level ?? "us-states");
  const [measure, setMeasure] = useState<string>(
    spec.measure && measures.includes(spec.measure) ? spec.measure : (measures[0] ?? "value"),
  );
  const [ramp, setRamp] = useState<keyof typeof RAMPS>("Ocean");
  const [hover, setHover] = useState<{ name: string; value?: number } | null>(null);

  const { topology, failed } = useAtlas(level);

  const values = useMemo(() => {
    const map = new Map<string, { value: number; label: string }>();
    for (const row of rows) {
      const id = regionId(level, row?.[regionKey]);
      const raw = Number(row?.[measure]);
      if (!id || !Number.isFinite(raw)) continue;
      map.set(id, { value: raw, label: `${row?.[regionKey] ?? id}` });
    }
    return map;
  }, [level, measure, regionKey, rows]);

  const domain = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const entry of values.values()) {
      if (entry.value < min) min = entry.value;
      if (entry.value > max) max = entry.value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1] as [number, number];
    return [min, max] as [number, number];
  }, [values]);

  const colorFor = useMemo(() => {
    const range = RAMPS[ramp] as string[];
    const scale = scaleQuantize<string>().domain(domain).range(range);
    return (value: number | undefined) =>
      value === undefined ? "var(--color-muted)" : scale(value);
  }, [domain, ramp]);

  const focusKey = spec.focus ? countryKey(spec.focus) : null;

  const projectionConfig = useMemo(() => {
    if (level === "world") return { scale: 145 } as const;
    return undefined;
  }, [level]);

  const hasData = values.size > 0 || points.length > 0;

  return (
    <figure className="my-3 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {spec.title ? (
          <figcaption className="mr-auto text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {spec.title}
          </figcaption>
        ) : null}
        <select
          value={level}
          onChange={(event) => setLevel(event.target.value as MapLevel)}
          aria-label="Map geography level"
          className="rounded-md border border-border bg-secondary px-2 py-1 text-[11px]"
        >
          <option value="us-states">US states</option>
          <option value="us-counties">US counties</option>
          <option value="world">World countries</option>
        </select>
        {measures.length > 1 ? (
          <select
            value={measure}
            onChange={(event) => setMeasure(event.target.value)}
            aria-label="Map measure"
            className="rounded-md border border-border bg-secondary px-2 py-1 text-[11px]"
          >
            {measures.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        ) : null}
        <select
          value={ramp}
          onChange={(event) => setRamp(event.target.value as keyof typeof RAMPS)}
          aria-label="Map colour scale"
          className="rounded-md border border-border bg-secondary px-2 py-1 text-[11px]"
        >
          {Object.keys(RAMPS).map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </div>

      {!hasData ? (
        <p className="text-xs text-muted-foreground">
          {spec.note ??
            "No usable location values were found for this map, so nothing could be shaded."}
        </p>
      ) : (
        <>
          <div className="relative h-72 w-full overflow-hidden rounded-lg bg-secondary/40">
            {failed && !topology ? (
              <p className="p-4 text-xs text-destructive">
                {failed} The numbers behind it are still correct — try switching the geography level
                or ask for a bar chart instead.
              </p>
            ) : !topology ? (
              <p className="p-4 text-xs text-muted-foreground">Loading map outlines…</p>
            ) : (
              <ComposableMap
                projection={level === "world" ? "geoEqualEarth" : "geoAlbersUsa"}
                {...(projectionConfig ? { projectionConfig } : {})}
                width={800}
                height={420}
                style={{ width: "100%", height: "100%" }}
              >
                <ZoomableGroup>
                  <Geographies geography={topology as never}>
                    {({ geographies }) =>
                      geographies
                        .filter((geo) => !focusKey || featureKey(level, geo) === focusKey)
                        .map((geo) => {
                          const key = featureKey(level, geo);
                          const hit = values.get(key);
                          return (
                            <Geography
                              key={geo.rsmKey}
                              geography={geo}
                              fill={colorFor(hit?.value)}
                              stroke="var(--color-border)"
                              strokeWidth={level === "us-counties" ? 0.2 : 0.4}
                              onMouseEnter={() =>
                                setHover({
                                  name:
                                    hit?.label ??
                                    `${(geo.properties as Record<string, unknown>)?.["name"] ?? key}`,
                                  ...(hit ? { value: hit.value } : {}),
                                })
                              }
                              onMouseLeave={() => setHover(null)}
                              style={{
                                default: { outline: "none" },
                                hover: { outline: "none", opacity: 0.8 },
                                pressed: { outline: "none" },
                              }}
                            />
                          );
                        })
                    }
                  </Geographies>

                  {points
                    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
                    .map((point, index) => (
                      <Marker
                        key={index}
                        coordinates={[point.lng as number, point.lat as number]}
                        onMouseEnter={() =>
                          setHover({
                            name: point.label ?? `${point.lat}, ${point.lng}`,
                            ...(point.value !== undefined ? { value: point.value } : {}),
                          })
                        }
                        onMouseLeave={() => setHover(null)}
                      >
                        <circle
                          r={4}
                          fill="var(--color-accent)"
                          stroke="var(--color-background)"
                          strokeWidth={1}
                        />
                      </Marker>
                    ))}
                </ZoomableGroup>
              </ComposableMap>
            )}

            {hover ? (
              <div className="pointer-events-none absolute left-2 top-2 rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow">
                <span className="font-medium">{hover.name}</span>
                {hover.value !== undefined ? ` — ${measure}: ${numberFmt(hover.value)}` : " — no data"}
              </div>
            ) : null}
          </div>

          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{numberFmt(domain[0])}</span>
            {(RAMPS[ramp] as string[]).map((color) => (
              <span
                key={color}
                className={cn("h-3 flex-1 rounded-sm")}
                style={{ background: color }}
              />
            ))}
            <span>{numberFmt(domain[1])}</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Shaded by {measure}
            {points.length ? ` · ${points.length} point marker${points.length > 1 ? "s" : ""}` : ""}
          </p>
        </>
      )}
    </figure>
  );
}
