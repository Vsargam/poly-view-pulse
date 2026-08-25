import { isBlankValue, requireColumn, type Row, type Table } from "./engine";

/**
 * Row-wise append of several tables (the pandas `concat` equivalent), with an
 * optional source-marker column so the merged file records where each row came
 * from. Columns missing from an input are filled blank.
 */
export function stackTables(
  inputs: { name: string; table: Table; marker?: string | number }[],
  options: { source_column?: string } = {},
): Table & { perFile: { name: string; rows: number }[] } {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs)
    for (const column of input.table.columns)
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }

  const sourceColumn = options.source_column?.trim();
  if (sourceColumn && !seen.has(sourceColumn)) columns.push(sourceColumn);

  const rows: Row[] = [];
  const perFile: { name: string; rows: number }[] = [];
  for (const input of inputs) {
    for (const row of input.table.rows) {
      const next: Row = {};
      for (const column of columns) next[column] = row?.[column] ?? null;
      if (sourceColumn) next[sourceColumn] = input.marker ?? input.name;
      rows.push(next);
    }
    perFile.push({ name: input.name, rows: input.table.rows.length });
  }

  return { columns, rows, perFile };
}

/**
 * Left / inner join a table to a second table on a key column, bringing in
 * selected columns (all non-key columns when none are named).
 */
export function joinTables(
  left: Table,
  right: Table,
  options: {
    key: string;
    right_key?: string;
    columns?: string[];
    how?: "left" | "inner";
  },
): Table & { matched: number; unmatched: number } {
  const leftKey = requireColumn(left.columns, options.key, "join key");
  const rightKey = requireColumn(right.columns, options.right_key ?? options.key, "join key");
  const bring = (
    options.columns?.length ? options.columns : right.columns.filter((column) => column !== rightKey)
  ).map((column) => requireColumn(right.columns, column, "column"));

  const index = new Map<string, Row>();
  for (const row of right.rows) {
    const key = `${row?.[rightKey] ?? ""}`.trim().toLowerCase();
    if (key && !index.has(key)) index.set(key, row);
  }

  const columns = [...left.columns];
  for (const column of bring) if (!columns.includes(column)) columns.push(column);

  let matched = 0;
  let unmatched = 0;
  const rows: Row[] = [];
  for (const row of left.rows) {
    const key = `${row?.[leftKey] ?? ""}`.trim().toLowerCase();
    const hit = index.get(key);
    if (!hit) {
      unmatched += 1;
      if ((options.how ?? "left") === "inner") continue;
    } else matched += 1;
    const next: Row = {};
    for (const column of columns)
      next[column] = bring.includes(column) && !left.columns.includes(column)
        ? (hit?.[column] ?? null)
        : (row?.[column] ?? hit?.[column] ?? null);
    rows.push(next);
  }

  return { columns, rows, matched, unmatched };
}

export const countBlank = (rows: Row[], column: string) =>
  rows.reduce((total, row) => total + (isBlankValue(row?.[column]) ? 1 : 0), 0);
