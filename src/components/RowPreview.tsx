import { useMemo } from "react";

import { useDataFiles } from "@/lib/ops/files-context";
import type { Row } from "@/lib/ops/engine";

const cell = (value: unknown) => {
  if (value === null || value === undefined) return "";
  const text = `${value}`;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

/** Compact scrollable sample of a table's first rows. */
export function RowPreview({
  rows,
  totalRows,
  title,
  maxRows = 8,
  maxColumns = 12,
}: {
  rows: Row[];
  totalRows?: number;
  title?: string;
  maxRows?: number;
  maxColumns?: number;
}) {
  const columns = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
  if (!rows.length) {
    return (
      <p className="text-[11px] text-muted-foreground">
        This file&apos;s rows are no longer available in this session.
      </p>
    );
  }

  const shown = columns.slice(0, maxColumns);
  const hiddenColumns = columns.length - shown.length;
  const sample = rows.slice(0, maxRows);

  return (
    <div className="min-w-0">
      {title ? (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      ) : null}
      <div className="max-h-56 overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-left text-[11px]">
          <thead className="sticky top-0 bg-secondary/80 backdrop-blur">
            <tr>
              {shown.map((column) => (
                <th
                  key={column}
                  className="whitespace-nowrap border-b border-border px-2 py-1 font-semibold text-foreground"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.map((row, index) => (
              <tr key={index} className="odd:bg-secondary/20">
                {shown.map((column) => (
                  <td
                    key={column}
                    className="whitespace-nowrap px-2 py-1 text-muted-foreground"
                    title={`${row[column] ?? ""}`}
                  >
                    {cell(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Showing {sample.length} of {(totalRows ?? rows.length).toLocaleString()} rows ·{" "}
        {columns.length} columns
        {hiddenColumns > 0 ? ` (${hiddenColumns} more not shown)` : ""}
      </p>
    </div>
  );
}

export type PreviewSpec = {
  type?: "preview";
  file?: string;
  title?: string;
  limit?: number;
  rows?: Row[];
};

/** Inline chat preview of a generated file, read from the session's loaded files. */
export function FilePreviewBlock({ spec }: { spec: PreviewSpec }) {
  const { getRows } = useDataFiles();
  const rows = Array.isArray(spec.rows) && spec.rows.length ? spec.rows : getRows(spec.file ?? "");

  return (
    <figure className="my-3 rounded-xl border border-border bg-card p-3">
      <RowPreview
        rows={rows ?? []}
        title={spec.title ?? (spec.file ? `Preview — ${spec.file}` : "Preview")}
        maxRows={spec.limit && spec.limit > 0 ? Math.min(spec.limit, 25) : 8}
      />
    </figure>
  );
}
