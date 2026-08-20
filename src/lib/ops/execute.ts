import {
  aggregate,
  asTable,
  deriveColumns,
  distinctValues,
  fillMissing,
  filterRows,
  lookupReplace,
  pairOverlap,
  reorder,
  sortRows,
  type Row,
  type Table,
} from "./engine";

export type FileHandle = { id: string; name: string; rows: Row[] };

export type FileStore = {
  /** Resolve a file by (fuzzy) name. */
  find: (name: string) => FileHandle | null;
  list: () => { name: string; rows: number }[];
  /** Register a generated file in the conversation; returns its final name. */
  add: (name: string, table: Table, note: string, sourceName: string) => string;
};

const PREVIEW_ROWS = 25;

const preview = (table: Table, limit = PREVIEW_ROWS) => ({
  columns: table.columns,
  rows: reorder(table.rows.slice(0, limit), table.columns),
});

function requireFile(store: FileStore, name: string): FileHandle {
  const hit = store.find(name);
  if (hit) return hit;
  const available = store.list().map((file) => file.name);
  throw new Error(
    `No file named "${name}" is loaded in this conversation.${
      available.length ? ` Loaded files: ${available.join(", ")}.` : " Ask the user to upload it."
    }`,
  );
}

const defaultName = (base: string, suffix: string) => {
  const stem = base.replace(/\.(csv|tsv|json|xlsx|xls)$/i, "");
  return `${stem}_${suffix}.csv`;
};

/** Runs one analysis tool call in the browser against the full uploaded rows. */
export async function runOpTool(
  toolName: string,
  rawInput: unknown,
  store: FileStore,
): Promise<Record<string, unknown>> {
  const input = (rawInput ?? {}) as Record<string, never>;
  const fileName = input["file"] as unknown as string;

  if (toolName === "preview_file") {
    const handle = requireFile(store, fileName);
    const table = asTable(handle.rows);
    const limit = Math.min(Number(input["limit"] ?? 15) || 15, 60);
    return {
      file: handle.name,
      rowCount: handle.rows.length,
      ...preview(table, limit),
    };
  }

  if (toolName === "distinct_values") {
    const handle = requireFile(store, fileName);
    const result = distinctValues(asTable(handle.rows), input["column"] as unknown as string);
    return { file: handle.name, ...result };
  }

  if (toolName === "add_columns") {
    const handle = requireFile(store, fileName);
    const result = deriveColumns(asTable(handle.rows), (input["columns"] as unknown as never[]) ?? []);
    const name =
      (input["output_file"] as unknown as string) || defaultName(handle.name, "augmented");
    const finalName = store.add(
      name,
      { columns: result.columns, rows: result.rows },
      `Derived from ${handle.name}: ${result.notes.join(" ")}`,
      handle.name,
    );
    return {
      created_file: finalName,
      rowCount: result.rows.length,
      notes: result.notes,
      ...preview({ columns: result.columns, rows: result.rows }, 8),
    };
  }

  if (toolName === "aggregate") {
    const handle = requireFile(store, fileName);
    const table = aggregate(asTable(handle.rows), {
      group_by: (input["group_by"] as unknown as string[]) ?? [],
      metrics: (input["metrics"] as unknown as never[]) ?? [],
      ...(input["sort_by"] ? { sort_by: input["sort_by"] as unknown as string } : {}),
      ...(input["direction"] ? { direction: input["direction"] as unknown as "asc" | "desc" } : {}),
      ...(input["limit"] ? { limit: Number(input["limit"]) } : {}),
    });
    const name = (input["output_file"] as unknown as string) || defaultName(handle.name, "summary");
    const finalName = store.add(name, table, `Aggregated from ${handle.name}`, handle.name);
    return {
      created_file: finalName,
      groupCount: table.rows.length,
      rowsScanned: handle.rows.length,
      ...preview(table),
    };
  }

  if (toolName === "filter_rows") {
    const handle = requireFile(store, fileName);
    const table = filterRows(asTable(handle.rows), {
      column: input["column"] as unknown as string,
      op: input["op"] as unknown as never,
      ...(input["values"] ? { values: input["values"] as unknown as (string | number)[] } : {}),
    });
    const name = (input["output_file"] as unknown as string) || defaultName(handle.name, "filtered");
    const finalName = store.add(name, table, `Filtered from ${handle.name}`, handle.name);
    return {
      created_file: finalName,
      rowsBefore: handle.rows.length,
      rowsAfter: table.rows.length,
      rowsRemoved: handle.rows.length - table.rows.length,
      ...preview(table, 5),
    };
  }

  if (toolName === "lookup_replace") {
    const handle = requireFile(store, fileName);
    const lookup = requireFile(store, input["lookup_file"] as unknown as string);
    const result = lookupReplace(asTable(handle.rows), asTable(lookup.rows), {
      column: input["column"] as unknown as string,
      key_column: input["key_column"] as unknown as string,
      value_column: input["value_column"] as unknown as string,
      ...(input["unmatched"] ? { unmatched: input["unmatched"] as unknown as never } : {}),
    });
    const name =
      (input["output_file"] as unknown as string) || defaultName(handle.name, "recoded");
    const finalName = store.add(
      name,
      { columns: result.columns, rows: result.rows },
      `Recoded ${input["column"]} in ${handle.name} using ${lookup.name}`,
      handle.name,
    );
    return {
      created_file: finalName,
      rowCount: result.rows.length,
      replaced: result.replaced,
      unmatched: result.unmatched,
      ...preview({ columns: result.columns, rows: result.rows }, 5),
    };
  }

  if (toolName === "top_n") {
    const handle = requireFile(store, fileName);
    const source = asTable(handle.rows);
    const column = input["column"] as unknown as string;
    const limit = Math.min(Number(input["limit"] ?? 20) || 20, 200);
    const sorted = sortRows(source.rows, column, (input["direction"] as unknown as "asc" | "desc") ?? "desc").slice(
      0,
      limit,
    );
    const table: Table = { columns: source.columns, rows: sorted };
    const name = (input["output_file"] as unknown as string) || defaultName(handle.name, `top${limit}`);
    const finalName = store.add(name, table, `Top ${limit} of ${handle.name} by ${column}`, handle.name);
    return { created_file: finalName, ...preview(table, limit) };
  }

  if (toolName === "fill_missing") {
    const handle = requireFile(store, fileName);
    const result = fillMissing(asTable(handle.rows), {
      ...(input["columns"] ? { columns: input["columns"] as unknown as string[] } : {}),
      ...(input["value"] !== undefined ? { value: input["value"] as unknown as string | number } : {}),
      ...(input["drop_rows"] ? { drop_rows: true } : {}),
    });
    const name = (input["output_file"] as unknown as string) || defaultName(handle.name, "clean");
    const finalName = store.add(
      name,
      { columns: result.columns, rows: result.rows },
      `Missing values handled from ${handle.name}`,
      handle.name,
    );
    return {
      created_file: finalName,
      rowCount: result.rows.length,
      cellsFilled: result.filled,
      rowsDropped: result.dropped,
      ...preview({ columns: result.columns, rows: result.rows }, 5),
    };
  }

  if (toolName === "pair_overlap") {
    const handle = requireFile(store, fileName);
    const result = pairOverlap(asTable(handle.rows), {
      entity_column: input["entity_column"] as unknown as string,
      member_column: input["member_column"] as unknown as string,
      ...(input["measure_column"] ? { measure_column: input["measure_column"] as unknown as string } : {}),
      ...(input["min_shared"] ? { min_shared: Number(input["min_shared"]) } : {}),
      ...(input["entity_a"] ? { entity_a: input["entity_a"] as unknown as string } : {}),
      ...(input["entity_b"] ? { entity_b: input["entity_b"] as unknown as string } : {}),
      ...(input["limit"] ? { limit: Number(input["limit"]) } : {}),
    });
    const name = (input["output_file"] as unknown as string) || defaultName(handle.name, "provider_pairs");
    const finalName = store.add(name, result.table, `Pair overlap from ${handle.name}`, handle.name);
    return {
      created_file: finalName,
      totalPairs: result.totalPairs,
      ...(result.requestedPair ? { requestedPair: result.requestedPair } : {}),
      ...preview(result.table, 20),
    };
  }

  throw new Error(`Unknown analysis tool "${toolName}".`);
}
