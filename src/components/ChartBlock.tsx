import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type ChartSpec = {
  type?: "bar" | "line" | "area" | "pie";
  title?: string;
  xKey?: string;
  yKey?: string;
  data?: Record<string, unknown>[];
};

const PALETTE = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

export function ChartBlock({ spec }: { spec: ChartSpec }) {
  const data = Array.isArray(spec.data) ? spec.data : [];
  if (!data.length) return null;

  const keys = Object.keys(data[0] ?? {});
  const xKey = spec.xKey && keys.includes(spec.xKey) ? spec.xKey : (keys[0] ?? "label");
  const yKey =
    spec.yKey && keys.includes(spec.yKey)
      ? spec.yKey
      : (keys.find((key) => key !== xKey && typeof data[0]?.[key] === "number") ??
        keys[1] ??
        "value");
  const type = spec.type ?? "bar";

  const axis = {
    stroke: "var(--color-muted-foreground)",
    fontSize: 11,
    tickLine: false,
    axisLine: false,
  } as const;

  const tooltip = (
    <Tooltip
      contentStyle={{
        background: "var(--color-popover)",
        border: "1px solid var(--color-border)",
        borderRadius: "0.5rem",
        fontSize: "0.75rem",
        color: "var(--color-popover-foreground)",
      }}
    />
  );

  return (
    <figure className="my-3 rounded-xl border border-border bg-card p-4">
      {spec.title ? (
        <figcaption className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {spec.title}
        </figcaption>
      ) : null}
      <div className="h-64 w-full">
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
          ) : (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey={xKey} {...axis} interval={0} angle={-25} textAnchor="end" height={54} />
              <YAxis {...axis} />
              {tooltip}
              <Bar dataKey={yKey} radius={[4, 4, 0, 0]} fill="var(--color-chart-1)" />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
