/**
 * Deterministic, in-browser analysis engine.
 *
 * Every operation runs over the FULL rows of an uploaded file (never a sample),
 * is non-destructive (returns new rows), and preserves column order so derived
 * columns can be inserted at an exact position.
 *
 * No argument spreading over row-sized arrays anywhere in here — large files
 * must never blow the call stack.
 */

export type Row = Record<string, unknown>;

export type Table = { columns: string[]; rows: Row[] };

/* ------------------------------------------------------------------ helpers */

export function columnOrder(rows: Row[]): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const row of rows.slice(0, 500)) {
    for (const key of Object.keys(row ?? {})) {
      if (!set.has(key)) {
        set.add(key);
        seen.push(key);
      }
    }
  }
  return seen;
}

export const asTable = (rows: Row[]): Table => ({ columns: columnOrder(rows), rows });

const isBlank = (value: unknown) =>
  value === null || value === undefined || `${value}`.trim() === "";

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (isBlank(value)) return null;
  const cleaned = `${value}`.replace(/[$,%\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function toTime(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (isBlank(value)) return null;
  const text = `${value}`.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (us) {
    const year = Number(us[3]);
    return Date.UTC(year < 100 ? 2000 + year : year, Number(us[1]) - 1, Number(us[2]));
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

const round = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Reorder each row's keys so CSV export and previews follow `columns`. */
export function reorder(rows: Row[], columns: string[]): Row[] {
  return rows.map((row) => {
    const next: Row = {};
    for (const column of columns) next[column] = row?.[column] ?? null;
    for (const key of Object.keys(row ?? {})) if (!(key in next)) next[key] = row[key];
    return next;
  });
}

export function toCsv(rows: Row[], columns?: string[]): string {
  const cols = columns?.length ? columns : columnOrder(rows);
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const text = value instanceof Date ? value.toISOString().slice(0, 10) : `${value}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [cols.map(cell).join(",")];
  for (const row of rows) lines.push(cols.map((column) => cell(row?.[column])).join(","));
  return lines.join("\n");
}

/** Case/space-insensitive column resolution, so near-miss names still work. */
export function resolveColumn(columns: string[], wanted: string | undefined): string | null {
  if (!wanted) return null;
  const exact = columns.find((column) => column === wanted);
  if (exact) return exact;
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(wanted);
  return columns.find((column) => norm(column) === target) ?? null;
}

export function requireColumn(columns: string[], wanted: string | undefined, label = "column") {
  const found = resolveColumn(columns, wanted);
  if (!found)
    throw new Error(
      `No ${label} named "${wanted}" in that file. Available columns: ${columns.slice(0, 60).join(", ")}`,
    );
  return found;
}

export function sortRows(
  rows: Row[],
  column: string,
  direction: "asc" | "desc" = "desc",
): Row[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const na = toNumber(a?.[column]);
    const nb = toNumber(b?.[column]);
    if (na !== null && nb !== null) return (na - nb) * sign;
    return `${a?.[column] ?? ""}`.localeCompare(`${b?.[column] ?? ""}`) * sign;
  });
}

/* -------------------------------------------------------- derived columns */

export type DerivedColumn = {
  name: string;
  after?: string;
  before?: string;
  kind: "date_diff_days" | "value_frequency_share" | "arithmetic" | "constant";
  /** date_diff_days */
  start_column?: string;
  end_column?: string;
  /** value_frequency_share */
  column?: string;
  /** arithmetic */
  left_column?: string;
  right_column?: string;
  left_value?: number;
  right_value?: number;
  operator?: "+" | "-" | "*" | "/";
  /** constant */
  value?: string | number;
  decimals?: number;
};

export function deriveColumns(table: Table, specs: DerivedColumn[]): Table & { notes: string[] } {
  const { rows } = table;
  let columns = [...table.columns];
  const notes: string[] = [];
  const computed: Record<string, unknown[]> = {};

  for (const spec of specs) {
    const decimals = spec.decimals ?? (spec.kind === "value_frequency_share" ? 6 : 4);
    const values: unknown[] = new Array(rows.length).fill(null);

    if (spec.kind === "date_diff_days") {
      const start = requireColumn(columns, spec.start_column, "start date column");
      const end = requireColumn(columns, spec.end_column, "end date column");
      let missing = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const a = toTime(rows[i]?.[start]);
        const b = toTime(rows[i]?.[end]);
        if (a === null || b === null) {
          missing += 1;
          continue;
        }
        values[i] = Math.round((b - a) / 86_400_000);
      }
      notes.push(
        `${spec.name} = days between ${end} and ${start}${missing ? ` (${missing} rows left blank: a date was missing or unparseable)` : ""}.`,
      );
    } else if (spec.kind === "value_frequency_share") {
      const column = requireColumn(columns, spec.column, "column");
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = `${row?.[column] ?? ""}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const total = rows.length || 1;
      for (let i = 0; i < rows.length; i += 1) {
        const key = `${rows[i]?.[column] ?? ""}`;
        values[i] = round((counts.get(key) ?? 0) / total, decimals);
      }
      notes.push(
        `${spec.name} = occurrences of each ${column} value divided by ${total.toLocaleString()} total records.`,
      );
    } else if (spec.kind === "arithmetic") {
      const left = spec.left_column ? requireColumn(columns, spec.left_column, "column") : null;
      const right = spec.right_column ? requireColumn(columns, spec.right_column, "column") : null;
      const operator = spec.operator ?? "-";
      for (let i = 0; i < rows.length; i += 1) {
        const a = left ? toNumber(rows[i]?.[left]) : (spec.left_value ?? null);
        const b = right ? toNumber(rows[i]?.[right]) : (spec.right_value ?? null);
        if (a === null || b === null) continue;
        const result =
          operator === "+" ? a + b : operator === "*" ? a * b : operator === "/" ? (b === 0 ? null : a / b) : a - b;
        values[i] = result === null ? null : round(result, decimals);
      }
      notes.push(`${spec.name} = ${left ?? spec.left_value} ${operator} ${right ?? spec.right_value}.`);
    } else {
      for (let i = 0; i < rows.length; i += 1) values[i] = spec.value ?? null;
      notes.push(`${spec.name} = constant ${spec.value ?? "(blank)"}.`);
    }

    computed[spec.name] = values;

    // Insert the new column at the requested position, never at the end unless asked.
    const anchorAfter = resolveColumn(columns, spec.after);
    const anchorBefore = resolveColumn(columns, spec.before);
    const existing = columns.indexOf(spec.name);
    if (existing >= 0) columns.splice(existing, 1);
    if (anchorAfter) columns.splice(columns.indexOf(anchorAfter) + 1, 0, spec.name);
    else if (anchorBefore) columns.splice(columns.indexOf(anchorBefore), 0, spec.name);
    else columns.push(spec.name);
  }

  const nextRows = rows.map((row, index) => {
    const next: Row = {};
    for (const column of columns)
      next[column] = column in computed ? (computed[column] as unknown[])[index] : (row?.[column] ?? null);
    return next;
  });

  return { columns, rows: nextRows, notes };
}

/* -------------------------------------------------------------- aggregate */

export type Metric = {
  op:
    | "count"
    | "sum"
    | "avg"
    | "min"
    | "max"
    | "distinct_count"
    /** rows in the group / number of distinct values of `per_column` */
    | "count_per_distinct"
    /** distinct values of `column` / distinct values of `per_column` */
    | "distinct_per_distinct";
  column?: string;
  /** Denominator column for the ratio ops. */
  per_column?: string;
  as?: string;
};


export type AggregateOptions = {
  group_by: string[];
  metrics: Metric[];
  sort_by?: string;
  direction?: "asc" | "desc";
  limit?: number;
  include_blank_groups?: boolean;
};

export function aggregate(table: Table, options: AggregateOptions): Table {
  const groupBy = options.group_by.map((column) => requireColumn(table.columns, column, "group-by column"));
  const metrics = options.metrics.length
    ? options.metrics
    : ([{ op: "count", as: "# occurrences" }] as Metric[]);

  type Bucket = {
    keys: unknown[];
    count: number;
    sums: number[];
    counts: number[];
    mins: (number | null)[];
    maxes: (number | null)[];
    distinct: (Set<string> | null)[];
  };

  const metricColumns = metrics.map((metric) =>
    metric.column ? requireColumn(table.columns, metric.column, "metric column") : null,
  );

  const buckets = new Map<string, Bucket>();
  for (const row of table.rows) {
    const keys = groupBy.map((column) => row?.[column] ?? null);
    if (!options.include_blank_groups && keys.every((key) => isBlank(key))) continue;
    const id = keys.map((key) => `${key ?? ""}`).join("\u0001");
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = {
        keys,
        count: 0,
        sums: metrics.map(() => 0),
        counts: metrics.map(() => 0),
        mins: metrics.map(() => null),
        maxes: metrics.map(() => null),
        distinct: metrics.map((metric) => (metric.op === "distinct_count" ? new Set<string>() : null)),
      };
      buckets.set(id, bucket);
    }
    bucket.count += 1;
    for (let m = 0; m < metrics.length; m += 1) {
      const column = metricColumns[m];
      if (!column) continue;
      const raw = row?.[column];
      if (metrics[m]!.op === "distinct_count") {
        if (!isBlank(raw)) bucket.distinct[m]!.add(`${raw}`);
        continue;
      }
      const value = toNumber(raw);
      if (value === null) continue;
      bucket.counts[m] = (bucket.counts[m] ?? 0) + 1;
      bucket.sums[m] = (bucket.sums[m] ?? 0) + value;
      const currentMin = bucket.mins[m] ?? null;
      const currentMax = bucket.maxes[m] ?? null;
      if (currentMin === null || value < currentMin) bucket.mins[m] = value;
      if (currentMax === null || value > currentMax) bucket.maxes[m] = value;
    }
  }

  const metricNames = metrics.map((metric, index) => {
    const column = metricColumns[index];
    return (
      metric.as ??
      (metric.op === "count" ? "# occurrences" : `${metric.op}_${column ?? "rows"}`)
    );
  });

  const rows: Row[] = [];
  for (const bucket of buckets.values()) {
    const row: Row = {};
    groupBy.forEach((column, index) => {
      row[column] = bucket.keys[index] ?? null;
    });
    metrics.forEach((metric, index) => {
      const name = metricNames[index] as string;
      if (metric.op === "count") row[name] = bucket.count;
      else if (metric.op === "distinct_count") row[name] = bucket.distinct[index]?.size ?? 0;
      else if (metric.op === "sum") row[name] = round(bucket.sums[index] ?? 0, 4);
      else if (metric.op === "avg")
        row[name] = bucket.counts[index] ? round((bucket.sums[index] ?? 0) / (bucket.counts[index] as number), 4) : null;
      else if (metric.op === "min") row[name] = bucket.mins[index];
      else row[name] = bucket.maxes[index];
    });
    rows.push(row);
  }

  const columns = [...groupBy, ...metricNames];
  const sortColumn = options.sort_by ? (resolveColumn(columns, options.sort_by) ?? metricNames[0]) : metricNames[0];
  let sorted = sortColumn ? sortRows(rows, sortColumn, options.direction ?? "desc") : rows;
  if (options.limit && options.limit > 0) sorted = sorted.slice(0, options.limit);

  return { columns, rows: sorted };
}

/* ----------------------------------------------------------------- filters */

export type FilterOptions = {
  column: string;
  op:
    | "in"
    | "not_in"
    | "equals"
    | "not_equals"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "contains"
    | "is_null"
    | "not_null";
  values?: (string | number)[];
};

export function filterRows(table: Table, options: FilterOptions): Table {
  const column = requireColumn(table.columns, options.column, "column");
  const values = (options.values ?? []).map((value) => `${value}`.trim().toLowerCase());
  const numeric = toNumber(options.values?.[0]);

  const keep = (row: Row) => {
    const raw = row?.[column];
    const text = `${raw ?? ""}`.trim().toLowerCase();
    const num = toNumber(raw);
    switch (options.op) {
      case "in":
        return values.includes(text);
      case "not_in":
        return !values.includes(text);
      case "equals":
        return text === (values[0] ?? "");
      case "not_equals":
        return text !== (values[0] ?? "");
      case "contains":
        return text.includes(values[0] ?? "");
      case "gt":
        return num !== null && numeric !== null && num > numeric;
      case "gte":
        return num !== null && numeric !== null && num >= numeric;
      case "lt":
        return num !== null && numeric !== null && num < numeric;
      case "lte":
        return num !== null && numeric !== null && num <= numeric;
      case "is_null":
        return isBlank(raw);
      default:
        return !isBlank(raw);
    }
  };

  return { columns: table.columns, rows: table.rows.filter(keep) };
}

/* ---------------------------------------------------------- lookup replace */

export type LookupOptions = {
  column: string;
  key_column: string;
  value_column: string;
  unmatched?: "keep" | "blank" | "drop_row";
};

export function lookupReplace(
  table: Table,
  lookup: Table,
  options: LookupOptions,
): Table & { replaced: number; unmatched: number } {
  const column = requireColumn(table.columns, options.column, "column");
  const keyColumn = requireColumn(lookup.columns, options.key_column, "lookup key column");
  const valueColumn = requireColumn(lookup.columns, options.value_column, "lookup value column");

  const map = new Map<string, unknown>();
  for (const row of lookup.rows) {
    const key = `${row?.[keyColumn] ?? ""}`.trim().toLowerCase();
    if (key) map.set(key, row?.[valueColumn] ?? null);
  }

  let replaced = 0;
  let unmatched = 0;
  const rows: Row[] = [];
  for (const row of table.rows) {
    const key = `${row?.[column] ?? ""}`.trim().toLowerCase();
    const hit = map.has(key) ? map.get(key) : undefined;
    if (hit === undefined) {
      unmatched += 1;
      if (options.unmatched === "drop_row") continue;
      rows.push(options.unmatched === "blank" ? { ...row, [column]: null } : { ...row });
      continue;
    }
    replaced += 1;
    rows.push({ ...row, [column]: hit }); // position preserved: same key, new value
  }

  return { columns: table.columns, rows, replaced, unmatched };
}

/* ----------------------------------------------------------- fill missing */

export function fillMissing(
  table: Table,
  options: { columns?: string[]; value?: string | number; drop_rows?: boolean },
): Table & { filled: number; dropped: number } {
  const targets = (options.columns?.length ? options.columns : table.columns).map((column) =>
    requireColumn(table.columns, column, "column"),
  );
  let filled = 0;
  let dropped = 0;
  const rows: Row[] = [];
  for (const row of table.rows) {
    const missing = targets.some((column) => isBlank(row?.[column]));
    if (missing && options.drop_rows) {
      dropped += 1;
      continue;
    }
    if (!missing) {
      rows.push(row);
      continue;
    }
    const next: Row = { ...row };
    for (const column of targets)
      if (isBlank(next[column])) {
        next[column] = options.value ?? 0;
        filled += 1;
      }
    rows.push(next);
  }
  return { columns: table.columns, rows, filled, dropped };
}

/* --------------------------------------------------------- distinct values */

export function distinctValues(table: Table, column: string) {
  const resolved = requireColumn(table.columns, column, "column");
  const counts = new Map<string, number>();
  let blank = 0;
  for (const row of table.rows) {
    const raw = row?.[resolved];
    if (isBlank(raw)) {
      blank += 1;
      continue;
    }
    const key = `${raw}`.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([value, count]) => ({ value, count }));
  return { column: resolved, distinctCount: counts.size, blankRows: blank, rowsScanned: table.rows.length, top };
}

/* ------------------------------------------------------------ link analysis */

export type PairOptions = {
  entity_column: string;
  member_column: string;
  measure_column?: string;
  min_shared?: number;
  entity_a?: string;
  entity_b?: string;
  limit?: number;
};

export type PairResult = {
  table: Table;
  totalPairs: number;
  requestedPair?: { a: string; b: string; shared: number; members: string[] };
};

const ENTITY_CAP = 4000;

export function pairOverlap(table: Table, options: PairOptions): PairResult {
  const entityColumn = requireColumn(table.columns, options.entity_column, "entity column");
  const memberColumn = requireColumn(table.columns, options.member_column, "member column");
  const measureColumn = options.measure_column
    ? requireColumn(table.columns, options.measure_column, "measure column")
    : null;

  // member -> set of entities, and (entity,member) -> measure sum
  const byMember = new Map<string, Set<string>>();
  const measureByPairKey = new Map<string, number>();
  for (const row of table.rows) {
    const entity = `${row?.[entityColumn] ?? ""}`.trim();
    const member = `${row?.[memberColumn] ?? ""}`.trim();
    if (!entity || !member) continue;
    let set = byMember.get(member);
    if (!set) {
      set = new Set<string>();
      byMember.set(member, set);
    }
    set.add(entity);
    if (measureColumn) {
      const value = toNumber(row?.[measureColumn]) ?? 0;
      const key = `${entity}\u0001${member}`;
      measureByPairKey.set(key, (measureByPairKey.get(key) ?? 0) + value);
    }
  }

  const shared = new Map<string, { a: string; b: string; count: number; measure: number; members: string[] }>();
  for (const [member, entitySet] of byMember) {
    if (entitySet.size < 2) continue;
    const entities = [...entitySet].sort();
    if (entities.length > 200) continue; // pathological member, skip to stay responsive
    for (let i = 0; i < entities.length; i += 1) {
      for (let j = i + 1; j < entities.length; j += 1) {
        const a = entities[i] as string;
        const b = entities[j] as string;
        const key = `${a}\u0001${b}`;
        let entry = shared.get(key);
        if (!entry) {
          entry = { a, b, count: 0, measure: 0, members: [] };
          shared.set(key, entry);
        }
        entry.count += 1;
        if (entry.members.length < 50) entry.members.push(member);
        if (measureColumn)
          entry.measure +=
            (measureByPairKey.get(`${a}\u0001${member}`) ?? 0) +
            (measureByPairKey.get(`${b}\u0001${member}`) ?? 0);
      }
    }
    if (shared.size > ENTITY_CAP * 200) break;
  }

  const minShared = options.min_shared && options.min_shared > 0 ? options.min_shared : 1;
  const entity1 = `${entityColumn} 1`;
  const entity2 = `${entityColumn} 2`;
  const sharedName = `Common_${memberColumn}`;
  const measureName = measureColumn ? `Total_${measureColumn}` : null;

  const rows: Row[] = [];
  for (const entry of shared.values()) {
    if (entry.count < minShared) continue;
    const row: Row = { [entity1]: entry.a, [entity2]: entry.b, [sharedName]: entry.count };
    if (measureName) row[measureName] = round(entry.measure, 2);
    rows.push(row);
  }

  const columns = [entity1, entity2, sharedName, ...(measureName ? [measureName] : [])];
  let sorted = sortRows(rows, sharedName, "desc");
  const totalPairs = sorted.length;
  if (options.limit && options.limit > 0) sorted = sorted.slice(0, options.limit);

  const result: PairResult = { table: { columns, rows: sorted }, totalPairs };

  if (options.entity_a && options.entity_b) {
    const a = options.entity_a.trim();
    const b = options.entity_b.trim();
    const key = a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
    const entry = shared.get(key);
    result.requestedPair = {
      a,
      b,
      shared: entry?.count ?? 0,
      members: entry?.members.slice(0, 25) ?? [],
    };
  }

  return result;
}
