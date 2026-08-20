import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useBlockRows, type DataQuery } from "@/lib/ops/files-context";

export type ChartSpec = DataQuery & {
  type?: "bar" | "line" | "area" | "pie";
  title?: string;
  xKey?: string;
  yKey?: string;
  /** "horizontal" draws horizontal bars (categories down the y axis). */
  orientation?: "horizontal" | "vertical";
  showValues?: boolean;
  data?: Record<string, unknown>[];
};

const PALETTE = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

const numberFmt = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return Math.abs(n) >= 1000
    ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : `${Math.round(n * 100) / 100}`;
};

export function ChartBlock({ spec, compact = false }: { spec: ChartSpec; compact?: boolean }) {
  const rows = useBlockRows(spec.data, spec, spec.yKey, 40);
  if (!rows.length) {
    return (
      <p className="my-3 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        {spec.file
          ? `No data available for the chart "${spec.title ?? spec.file}" — the file ${spec.file} is not loaded in this chat.`
          : "No data was supplied for this chart."}
      </p>
    );
  }

  const keys = Object.keys(rows[0] ?? {});
  const xKey = spec.xKey && keys.includes(spec.xKey) ? spec.xKey : (keys[0] ?? "label");
  const yKey =
    spec.yKey && keys.includes(spec.yKey)
      ? spec.yKey
      : (keys.find((key) => key !== xKey && Number.isFinite(Number(rows[0]?.[key]))) ??
        keys[1] ??
        "value");
  const type = spec.type ?? "bar";
  const horizontal = spec.orientation === "horizontal";

  const data = rows.map((row) => ({ ...row, [yKey]: Number(row?.[yKey]) }));

  const axis = {
    stroke: "var(--color-muted-foreground)",
    fontSize: 11,
    tickLine: false,
    axisLine: false,
  } as const;

  const tooltip = (
    <Tooltip
      formatter={(value: unknown) => numberFmt(value)}
      contentStyle={{
        background: "var(--color-popover)",
        border: "1px solid var(--color-border)",
        borderRadius: "0.5rem",
        fontSize: "0.75rem",
        color: "var(--color-popover-foreground)",
      }}
    />
  );

  const height = horizontal ? Math.max(220, Math.min(data.length * 22 + 60, 620)) : compact ? 260 : 280;

  return (
    <figure className="my-3 min-w-0 rounded-xl border border-border bg-card p-4">
      {spec.title ? (
        <figcaption className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {spec.title}
        </figcaption>
      ) : null}
      <div className="w-full" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {type === "pie" ? (
            <PieChart>
              {tooltip}
              <Pie data={data} dataKey={yKey} nameKey={xKey} outerRadius="80%" label>
                {data.map((_, index) => (
                  <Cell key={index} fill={PALETTE[index % PALETTE.length]} />
                ))}
              </Pie>
            </PieChart>
          ) : type === "line" ? (
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey={xKey} {...axis} />
              <YAxis {...axis} />
              {tooltip}
              <Line
                type="monotone"
                dataKey={yKey}
                stroke="var(--color-chart-1)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          ) : type === "area" ? (
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey={xKey} {...axis} />
              <YAxis {...axis} />
              {tooltip}
              <Area
                type="monotone"
                dataKey={yKey}
                stroke="var(--color-chart-1)"
                fill="var(--color-chart-1)"
                fillOpacity={0.2}
              />
            </AreaChart>
          ) : horizontal ? (
            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 34, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
              <XAxis type="number" {...axis} tickFormatter={numberFmt} />
              <YAxis type="category" dataKey={xKey} width={92} interval={0} {...axis} />
              {tooltip}
              <Bar dataKey={yKey} radius={[0, 4, 4, 0]} fill="var(--color-chart-1)" barSize={14}>
                {spec.showValues !== false ? (
                  <LabelList
                    dataKey={yKey}
                    position="right"
                    formatter={numberFmt}
                    style={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
                  />
                ) : null}
              </Bar>
            </BarChart>
          ) : (
            <BarChart data={data} margin={{ top: 16, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey={xKey} {...axis} interval={0} angle={-25} textAnchor="end" height={54} />
              <YAxis {...axis} tickFormatter={numberFmt} />
              {tooltip}
              <Bar dataKey={yKey} radius={[4, 4, 0, 0]} fill="var(--color-chart-1)">
                {spec.showValues ? (
                  <LabelList
                    dataKey={yKey}
                    position="top"
                    formatter={numberFmt}
                    style={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
                  />
                ) : null}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
