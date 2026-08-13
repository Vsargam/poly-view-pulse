import Papa from "papaparse";

export type Row = Record<string, unknown>;

export type ColumnProfile = {
  name: string;
  inferredType: "number" | "date" | "text" | "boolean" | "empty";
  missingPct: number;
  distinctCount: number;
  min?: number | string;
  max?: number | string;
  mean?: number;
  topValues?: { value: string; count: number }[];
  sampleValues: string[];
};

export type Dataset = {
  id: string;
  name: string;
  uploadedAt: string;
  rowCount: number;
  columns: ColumnProfile[];
  rows: Row[]; // capped sample kept in memory / storage
  fullRowsIncluded: boolean;
};

const MAX_STORED_ROWS = 400;

export async function parseFile(file: File): Promise<{ rows: Row[]; rowCount: number }> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".json")) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const rows: Row[] = Array.isArray(parsed)
      ? (parsed as Row[])
      : Array.isArray((parsed as Row)?.['data'])
        ? ((parsed as { data: Row[] }).data)
        : [parsed as Row];
    return { rows, rowCount: rows.length };
  }

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { cellDates: true });
    const sheetName = workbook.SheetNames[0] ?? "";
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return { rows: [], rowCount: 0 };
    const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: null });
    return { rows, rowCount: rows.length };
  }

  const text = await file.text();
  const delimiter = name.endsWith(".tsv") || name.endsWith(".tab") ? "\t" : undefined;
  const result = Papa.parse<Row>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    ...(delimiter ? { delimiter } : {}),
  });
  const rows = (result.data ?? []).filter(
    (row) => row && Object.values(row).some((value) => value !== null && value !== ""),
  );
  return { rows, rowCount: rows.length };
}

const looksLikeDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value);

function profileColumn(name: string, values: unknown[]): ColumnProfile {
  const total = values.length || 1;
  const present = values.filter((v) => v !== null && v !== undefined && `${v}`.trim() !== "");
  const strings = present.map((v) => (v instanceof Date ? v.toISOString() : `${v}`));
  const distinct = new Map<string, number>();
  for (const s of strings) distinct.set(s, (distinct.get(s) ?? 0) + 1);

  const numbers = strings
    .map((s) => Number(s.replace(/[$,%\s]/g, "")))
    .filter((n) => Number.isFinite(n));
  const numericRatio = present.length ? numbers.length / present.length : 0;
  const dateRatio = present.length ? strings.filter(looksLikeDate).length / present.length : 0;
  const boolRatio = present.length
    ? strings.filter((s) => /^(true|false|yes|no|y|n)$/i.test(s)).length / present.length
    : 0;

  let inferredType: ColumnProfile["inferredType"] = "text";
  if (!present.length) inferredType = "empty";
  else if (boolRatio > 0.9) inferredType = "boolean";
  else if (dateRatio > 0.8) inferredType = "date";
  else if (numericRatio > 0.85) inferredType = "number";

  const topValues = [...distinct.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([value, count]) => ({ value, count }));

  const profile: ColumnProfile = {
    name,
    inferredType,
    missingPct: Math.round(((total - present.length) / total) * 1000) / 10,
    distinctCount: distinct.size,
    sampleValues: strings.slice(0, 5),
  };

  if (inferredType === "number" && numbers.length) {
    // Loop instead of Math.min(...numbers): spreading large arrays overflows the call stack.
    let min = numbers[0] as number;
    let max = numbers[0] as number;
    let sum = 0;
    for (const n of numbers) {
      if (n < min) min = n;
      if (n > max) max = n;
      sum += n;
    }
    profile.min = min;
    profile.max = max;
    profile.mean = Math.round((sum / numbers.length) * 1000) / 1000;
  }
  if (inferredType === "date" && strings.length) {
    const sorted = [...strings].sort();
    profile.min = sorted[0] ?? "";
    profile.max = sorted[sorted.length - 1] ?? "";
  }
  if (distinct.size <= 40) profile.topValues = topValues;
  else profile.topValues = topValues.slice(0, 8);

  return profile;
}

export function buildDataset(name: string, rows: Row[], rowCount: number): Dataset {
  const columnNames = Array.from(
    rows.slice(0, 500).reduce<Set<string>>((set, row) => {
      Object.keys(row ?? {}).forEach((key) => set.add(key));
      return set;
    }, new Set<string>()),
  );

  const columns = columnNames.map((column) =>
    profileColumn(
      column,
      rows.map((row) => row?.[column]),
    ),
  );

  const stored = rows.length <= MAX_STORED_ROWS ? rows : rows.slice(0, MAX_STORED_ROWS);

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    uploadedAt: new Date().toISOString(),
    rowCount,
    columns,
    rows: stored,
    fullRowsIncluded: rows.length <= MAX_STORED_ROWS,
  };
}

const ICD10 = /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/i;
const ICD9 = /^(\d{3}(\.\d{1,2})?|[VE]\d{2,3}(\.\d{1,2})?)$/i;
const CPT = /^\d{5}$/;
const HCPCS = /^[A-V]\d{4}$/i;
const CDT = /^D\d{4}$/i;

/** Lightweight coding-system hints so the model can reason about clinical codes. */
export function codingHints(dataset: Dataset): string[] {
  const hints: string[] = [];
  for (const column of dataset.columns) {
    const values = dataset.rows
      .map((row) => row?.[column.name])
      .filter((v) => v !== null && v !== undefined && `${v}`.trim() !== "")
      .map((v) => `${v}`.trim());
    if (values.length < 3) continue;
    const share = (test: RegExp) => values.filter((v) => test.test(v)).length / values.length;
    const checks: [string, number][] = [
      ["ICD-10-CM diagnosis codes", share(ICD10)],
      ["ICD-9 diagnosis codes", share(ICD9)],
      ["CPT procedure codes", share(CPT)],
      ["HCPCS codes", share(HCPCS)],
      ["CDT dental codes", share(CDT)],
    ];
    const best = checks.sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const [label, ratio] = best;
    if (ratio > 0.5) {
      hints.push(
        `Column "${column.name}" looks like ${label} (${Math.round(ratio * 100)}% of values match; ${
          Math.round((1 - ratio) * 100)
        }% do not).`,
      );
    }
  }
  return hints;
}

export function claimTypeGuess(dataset: Dataset): string {
  const names = dataset.columns.map((c) => c.name.toLowerCase()).join(" ");
  const guesses: string[] = [];
  if (/(admit|discharge|drg|bed|los|room)/.test(names)) guesses.push("Inpatient");
  if (/(visit|outpatient|clinic|encounter)/.test(names)) guesses.push("Outpatient");
  if (/(tooth|dental|cdt|quadrant|surface)/.test(names)) guesses.push("Dental");
  if (/(ndc|rx|pharmac|days_supply|dayssupply|dispens|drug)/.test(names)) guesses.push("Pharmacy");
  return guesses.length ? guesses.join(" / ") : "unclear from the headers alone";
}

/** Compact, token-aware serialization of the dataset for the model. */
export function datasetContext(dataset: Dataset, charBudget = 90_000): string {
  const header = [
    `### Dataset: ${dataset.name}`,
    `Uploaded: ${dataset.uploadedAt}`,
    `Rows: ${dataset.rowCount}${dataset.fullRowsIncluded ? " (all rows included below)" : ` (first ${dataset.rows.length} rows included below)`}`,
    `Columns (${dataset.columns.length}):`,
    ...dataset.columns.map((column) => {
      const parts = [
        `- ${column.name} [${column.inferredType}] missing=${column.missingPct}% distinct=${column.distinctCount}`,
      ];
      if (column.mean !== undefined)
        parts.push(`min=${column.min} max=${column.max} mean=${column.mean}`);
      else if (column.min !== undefined) parts.push(`range=${column.min}..${column.max}`);
      if (column.topValues?.length)
        parts.push(
          `top: ${column.topValues.map((t) => `${t.value}(${t.count})`).join(", ")}`,
        );
      return parts.join(" | ");
    }),
    ...(codingHints(dataset).length ? ["Coding hints:", ...codingHints(dataset).map((h) => `- ${h}`)] : []),
    `Likely claim structure: ${claimTypeGuess(dataset)}`,
    "",
    "Row data (JSONL):",
  ].join("\n");

  const lines: string[] = [];
  let used = header.length;
  for (const row of dataset.rows) {
    const line = JSON.stringify(row);
    if (used + line.length > charBudget) {
      lines.push(`... (${dataset.rows.length - lines.length} further rows omitted for length)`);
      break;
    }
    used += line.length + 1;
    lines.push(line);
  }

  return `${header}\n${lines.join("\n")}`;
}
