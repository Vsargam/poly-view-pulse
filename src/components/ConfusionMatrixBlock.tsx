export type MatrixSpec = {
  title?: string;
  /** Class labels in matrix order. */
  classes?: string[];
  /** Rows = actual, columns = predicted. */
  matrix?: number[][];
  /** Optional headline metrics. */
  accuracy?: number;
  precision?: number;
  recall?: number;
  f_value?: number;
  fValue?: number;
  note?: string;
};

const percent = (value?: number) =>
  value === undefined || value === null ? null : `${(value * 100).toFixed(1)}%`;

/** Labelled confusion matrix with TN / FP / FN / TP annotations for 2-class models. */
export function ConfusionMatrixBlock({ spec }: { spec: MatrixSpec }) {
  const classes = spec.classes ?? [];
  const matrix = spec.matrix ?? [];
  if (!classes.length || !matrix.length) return null;

  const binary = classes.length === 2;
  const corner = (actual: number, predicted: number) =>
    !binary ? null : actual === 1 && predicted === 1 ? "TP" : actual === 1 ? "FN" : predicted === 1 ? "FP" : "TN";

  const metrics = [
    ["Accuracy", percent(spec.accuracy)],
    ["Precision", percent(spec.precision)],
    ["Recall", percent(spec.recall)],
    ["F-value", percent(spec.f_value ?? spec.fValue)],
  ].filter(([, value]) => value);

  return (
    <section className="my-3 min-w-0 rounded-xl border border-border/60 bg-card/50 p-3 backdrop-blur">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {spec.title ?? "Confusion matrix"}
      </h3>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr>
              <th className="p-2 text-left text-xs font-medium text-muted-foreground">
                Actual \ Predicted
              </th>
              {classes.map((label) => (
                <th key={label} className="p-2 text-xs font-medium text-muted-foreground">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {classes.map((label, actual) => (
              <tr key={label}>
                <th className="p-2 text-left text-xs font-medium text-muted-foreground">{label}</th>
                {classes.map((_, predicted) => {
                  const tag = corner(actual, predicted);
                  const correct = actual === predicted;
                  return (
                    <td
                      key={predicted}
                      className={`min-w-20 p-2 text-center tabular-nums ${
                        correct ? "bg-primary/15 font-semibold text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {(matrix[actual]?.[predicted] ?? 0).toLocaleString()}
                      {tag ? <span className="ml-1 text-[10px] opacity-70">{tag}</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {metrics.length ? (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {metrics.map(([label, value]) => (
            <div key={label as string} className="flex gap-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {spec.note ? <p className="mt-2 text-xs text-muted-foreground">{spec.note}</p> : null}
    </section>
  );
}
