/**
 * Local Outlier Factor over selected continuous columns, standardised so the
 * columns are comparable. Exact k-nearest-neighbour LOF (no approximation),
 * with a row cap because it is O(n^2) in the number of rows.
 */

import { requireColumn, toNumber, type Row, type Table } from "./engine";

export const LOF_ROW_CAP = 8000;

export type LofOptions = {
  columns?: string[];
  id_column?: string;
  k?: number;
  /** Rows with the highest LOF are labelled outliers. */
  contamination?: number;
  outlier_label?: string | number;
  inlier_label?: string | number;
  score_column?: string;
  prediction_column?: string;
};

const round = (value: number, decimals = 4) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Columns that look continuous, ordered as they appear in the file. */
export function continuousColumns(table: Table, exclude: string[] = []): string[] {
  const skip = new Set(exclude);
  const sample = table.rows.slice(0, 1000);
  const found: string[] = [];
  for (const column of table.columns) {
    if (skip.has(column)) continue;
    let numeric = 0;
    let present = 0;
    const distinct = new Set<string>();
    for (const row of sample) {
      const raw = row?.[column];
      if (raw === null || raw === undefined || `${raw}`.trim() === "") continue;
      present += 1;
      if (toNumber(raw) !== null) numeric += 1;
      if (distinct.size < 10) distinct.add(`${raw}`);
    }
    if (present && numeric / present >= 0.95 && distinct.size > 2) found.push(column);
  }
  return found;
}

export function localOutlierFactor(
  table: Table,
  options: LofOptions,
): Table & {
  columnsUsed: string[];
  k: number;
  rowsScored: number;
  outliers: number;
  threshold: number;
} {
  const idColumn = options.id_column ? requireColumn(table.columns, options.id_column, "column") : null;
  const requested = options.columns?.length
    ? options.columns.map((column) => requireColumn(table.columns, column, "column"))
    : continuousColumns(table, idColumn ? [idColumn] : []).slice(0, 5);
  if (requested.length < 2)
    throw new Error("Local Outlier Factor needs at least two continuous columns; none were usable in that file.");

  if (table.rows.length > LOF_ROW_CAP)
    throw new Error(
      `Local Outlier Factor is limited to ${LOF_ROW_CAP.toLocaleString()} rows here and this file has ${table.rows.length.toLocaleString()}. Aggregate it first (for example to the provider level) and run LOF on that file.`,
    );

  // Standardise each column.
  const n = table.rows.length;
  const dims = requested.length;
  const values = new Float64Array(n * dims);
  for (let d = 0; d < dims; d += 1) {
    const column = requested[d] as string;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      const value = toNumber(table.rows[i]?.[column]);
      if (value !== null) {
        sum += value;
        count += 1;
      }
    }
    const mean = count ? sum / count : 0;
    let variance = 0;
    for (let i = 0; i < n; i += 1) {
      const value = toNumber(table.rows[i]?.[column]);
      if (value !== null) variance += (value - mean) ** 2;
    }
    const sd = count > 1 ? Math.sqrt(variance / (count - 1)) || 1 : 1;
    for (let i = 0; i < n; i += 1) {
      const value = toNumber(table.rows[i]?.[column]);
      values[i * dims + d] = value === null ? 0 : (value - mean) / sd;
    }
  }

  const k = Math.max(2, Math.min(options.k ?? 20, n - 1));

  const distance = (a: number, b: number) => {
    let total = 0;
    for (let d = 0; d < dims; d += 1) {
      const diff = (values[a * dims + d] as number) - (values[b * dims + d] as number);
      total += diff * diff;
    }
    return Math.sqrt(total);
  };

  // k-nearest neighbours per point.
  const neighbours: number[][] = new Array(n);
  const kDistance = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const best: { index: number; d: number }[] = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const d = distance(i, j);
      if (best.length < k) {
        best.push({ index: j, d });
        if (best.length === k) best.sort((a, b) => a.d - b.d);
      } else if (d < (best[k - 1] as { d: number }).d) {
        best[k - 1] = { index: j, d };
        for (let p = k - 1; p > 0 && (best[p] as { d: number }).d < (best[p - 1] as { d: number }).d; p -= 1) {
          const tmp = best[p] as { index: number; d: number };
          best[p] = best[p - 1] as { index: number; d: number };
          best[p - 1] = tmp;
        }
      }
    }
    best.sort((a, b) => a.d - b.d);
    neighbours[i] = best.map((entry) => entry.index);
    kDistance[i] = (best[best.length - 1]?.d ?? 0) as number;
  }

  // Local reachability density.
  const lrd = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    const list = neighbours[i] as number[];
    for (const j of list) sum += Math.max(kDistance[j] as number, distance(i, j));
    lrd[i] = sum > 0 ? list.length / sum : Number.POSITIVE_INFINITY;
  }

  const scores = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const list = neighbours[i] as number[];
    let sum = 0;
    for (const j of list) sum += (lrd[j] as number) / (lrd[i] as number);
    scores[i] = list.length ? round(sum / list.length) : 1;
  }

  const contamination = Math.min(Math.max(options.contamination ?? 0.05, 0.001), 0.5);
  const sortedScores = Array.from(scores).sort((a, b) => b - a);
  const cutIndex = Math.max(0, Math.floor(n * contamination) - 1);
  const threshold = Math.max(sortedScores[cutIndex] ?? 1.5, 1);

  const outlierLabel = options.outlier_label ?? -1;
  const inlierLabel = options.inlier_label ?? 1;
  const predictionColumn = options.prediction_column?.trim() || "prediction";
  const scoreColumn = options.score_column?.trim() || "LOF_score";

  let outliers = 0;
  const rows: Row[] = [];
  for (let i = 0; i < n; i += 1) {
    const isOutlier = (scores[i] as number) >= threshold;
    if (isOutlier) outliers += 1;
    const row: Row = {};
    if (idColumn) row[idColumn] = table.rows[i]?.[idColumn] ?? null;
    row[predictionColumn] = isOutlier ? outlierLabel : inlierLabel;
    row[scoreColumn] = round(scores[i] as number);
    rows.push(row);
  }

  return {
    columns: [...(idColumn ? [idColumn] : []), predictionColumn, scoreColumn],
    rows,
    columnsUsed: requested,
    k,
    rowsScored: n,
    outliers,
    threshold: round(threshold),
  };
}
