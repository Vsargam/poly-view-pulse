import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import { useMemo, useState } from "react";

import { resolveColumn, toNumber } from "@/lib/ops/engine";
import { useBlockRows, type DataQuery } from "@/lib/ops/files-context";

export type NetworkEdgeInput = {
  source?: string;
  target?: string;
  value?: number;
  measure?: number;
};

export type NetworkSpec = DataQuery & {
  type?: "network";
  title?: string;
  /** Column names when reading edges from a generated pairs file. */
  sourceKey?: string;
  targetKey?: string;
  valueKey?: string;
  measureKey?: string;
  /** Only draw pairs with MORE than this many shared members. */
  threshold?: number;
  edges?: NetworkEdgeInput[];
  measureLabel?: string;
  valueLabel?: string;
};

type SimNode = { id: string; x?: number; y?: number; degree: number };
type SimLink = { source: SimNode | string; target: SimNode | string; value: number; measure: number | null };

const WIDTH = 760;
const HEIGHT = 480;

const numberFmt = (value: number) =>
  Math.abs(value) >= 1000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : `${Math.round(value * 100) / 100}`;

export function NetworkBlock({ spec }: { spec: NetworkSpec }) {
  const rows = useBlockRows(undefined, { ...spec, limit: spec.limit ?? 4000 }, spec.valueKey, 4000);
  const [hover, setHover] = useState<{ x: number; y: number; text: string[] } | null>(null);

  const { nodes, links, note } = useMemo(() => {
    const threshold = spec.threshold ?? 0;
    const raw: { source: string; target: string; value: number; measure: number | null }[] = [];

    if (spec.edges?.length) {
      for (const edge of spec.edges) {
        if (!edge.source || !edge.target) continue;
        raw.push({
          source: `${edge.source}`,
          target: `${edge.target}`,
          value: Number(edge.value ?? 1),
          measure: edge.measure === undefined ? null : Number(edge.measure),
        });
      }
    } else if (rows.length) {
      const columns = Object.keys(rows[0] ?? {});
      const sourceKey = resolveColumn(columns, spec.sourceKey) ?? columns[0];
      const targetKey = resolveColumn(columns, spec.targetKey) ?? columns[1];
      const valueKey =
        resolveColumn(columns, spec.valueKey) ??
        columns.find((column) => column !== sourceKey && column !== targetKey && toNumber(rows[0]?.[column]) !== null);
      const measureKey = resolveColumn(columns, spec.measureKey);
      for (const row of rows) {
        const source = `${row?.[sourceKey ?? ""] ?? ""}`.trim();
        const target = `${row?.[targetKey ?? ""] ?? ""}`.trim();
        if (!source || !target) continue;
        raw.push({
          source,
          target,
          value: toNumber(row?.[valueKey ?? ""]) ?? 1,
          measure: measureKey ? toNumber(row?.[measureKey]) : null,
        });
      }
    }

    const kept = raw.filter((edge) => edge.value > threshold);
    // Keep the graph readable: strongest links first.
    const limited = [...kept].sort((a, b) => b.value - a.value).slice(0, 220);

    const nodeMap = new Map<string, SimNode>();
    for (const edge of limited) {
      for (const id of [edge.source, edge.target]) {
        const existing = nodeMap.get(id);
        if (existing) existing.degree += 1;
        else nodeMap.set(id, { id, degree: 1 });
      }
    }

    const nodeList = [...nodeMap.values()];
    const linkList: SimLink[] = limited.map((edge) => ({
      source: edge.source,
      target: edge.target,
      value: edge.value,
      measure: edge.measure,
    }));

    if (nodeList.length) {
      const simulation = forceSimulation(nodeList as never[])
        .force(
          "link",
          forceLink(linkList as never[])
            .id((node) => (node as SimNode).id)
            .distance(140)
            .strength(0.35),
        )
        .force("charge", forceManyBody().strength(-420))
        .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
        .force("collide", forceCollide(30))
        .stop();
      simulation.tick(320);
    }

    return {
      nodes: nodeList,
      links: linkList,
      note:
        kept.length > limited.length
          ? `Showing the 220 strongest of ${kept.length.toLocaleString()} qualifying links.`
          : "",
    };
  }, [rows, spec.edges, spec.measureKey, spec.sourceKey, spec.targetKey, spec.threshold, spec.valueKey]);

  if (!nodes.length) {
    return (
      <p className="my-3 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        No pairs met the threshold{spec.threshold ? ` of more than ${spec.threshold} shared members` : ""}, so
        there is nothing to draw.
      </p>
    );
  }

  const maxValue = links.reduce((max, link) => Math.max(max, link.value), 1);
  const strokeFor = (value: number) => 1 + (value / maxValue) * 7;
  const valueLabel = spec.valueLabel ?? "Shared patients";

  return (
    <figure className="my-3 min-w-0 rounded-xl border border-border bg-card p-4">
      <figcaption className="mb-1 flex flex-wrap items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {spec.title ?? "Link analysis"}
        <span className="text-[10px] font-normal normal-case">
          {nodes.length} nodes · {links.length} links
          {spec.threshold ? ` · more than ${spec.threshold} shared` : ""}
        </span>
      </figcaption>

      <div className="relative w-full overflow-hidden rounded-lg bg-secondary/30">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-[480px] w-full">
          {links.map((link, index) => {
            const source = link.source as SimNode;
            const target = link.target as SimNode;
            if (source?.x === undefined || target?.x === undefined) return null;
            return (
              <line
                key={index}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke="var(--color-chart-2)"
                strokeOpacity={0.55}
                strokeWidth={strokeFor(link.value)}
                strokeLinecap="round"
                onMouseEnter={() =>
                  setHover({
                    x: ((source.x ?? 0) + (target.x ?? 0)) / 2,
                    y: ((source.y ?? 0) + (target.y ?? 0)) / 2,
                    text: [
                      `${source.id} ↔ ${target.id}`,
                      `${valueLabel}: ${numberFmt(link.value)}`,
                      ...(link.measure !== null && link.measure !== undefined
                        ? [`${spec.measureLabel ?? "Total measure"}: ${numberFmt(link.measure)}`]
                        : []),
                    ],
                  })
                }
                onMouseLeave={() => setHover(null)}
                style={{ cursor: "pointer" }}
              />
            );
          })}

          {nodes.map((node) => (
            <g key={node.id}>
              <circle
                cx={node.x}
                cy={node.y}
                r={7 + Math.min(node.degree, 8)}
                fill="var(--color-accent)"
                stroke="var(--color-background)"
                strokeWidth={1.5}
              />
              <text
                x={node.x}
                y={(node.y ?? 0) - 16}
                textAnchor="middle"
                fontSize={10}
                fill="var(--color-muted-foreground)"
              >
                {node.id}
              </text>
            </g>
          ))}
        </svg>

        {hover ? (
          <div className="pointer-events-none absolute left-2 top-2 rounded-md border border-border bg-popover px-2 py-1 text-[11px] leading-tight text-popover-foreground shadow">
            {hover.text.map((line, index) => (
              <p key={index} className={index === 0 ? "font-medium" : ""}>
                {line}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Edge thickness is proportional to shared members. Hover an edge for its numbers.
        {note ? ` ${note}` : ""}
      </p>
    </figure>
  );
}
