import { ChartBlock, type ChartSpec } from "@/components/ChartBlock";

export type ChartGridSpec = {
  title?: string;
  charts?: ChartSpec[];
  /** Alias the model sometimes uses. */
  panels?: ChartSpec[];
};

/** Two or more charts side by side, each with its own independent axes. */
export function ChartGrid({ spec }: { spec: ChartGridSpec }) {
  const charts = (spec.charts ?? spec.panels ?? []).filter(Boolean);
  if (!charts.length) return null;

  return (
    <section className="my-3 min-w-0">
      {spec.title ? (
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {spec.title}
        </h3>
      ) : null}
      <div
        className={`grid min-w-0 gap-3 ${charts.length > 1 ? "md:grid-cols-2" : "grid-cols-1"}`}
      >
        {charts.map((chart, index) => (
          <ChartBlock key={index} spec={chart} compact />
        ))}
      </div>
    </section>
  );
}
