import { createContext, useContext, useMemo } from "react";

import { resolveColumn, sortRows, type Row } from "./engine";

type FilesContextValue = {
  /** Full rows of a loaded file (uploaded or generated), by name. */
  getRows: (name: string) => Row[] | null;
  names: string[];
};

export const DataFilesContext = createContext<FilesContextValue>({
  getRows: () => null,
  names: [],
});

export const useDataFiles = () => useContext(DataFilesContext);

export type DataQuery = {
  /** Read the data straight from a loaded file instead of inline rows. */
  file?: string;
  sortBy?: string;
  sortDirection?: "asc" | "desc";
  limit?: number;
};

/**
 * Resolve a visualization block's rows: inline rows win, otherwise pull the
 * referenced file's real rows so charts never depend on retyped numbers.
 */
export function useBlockRows(
  inline: Row[] | undefined,
  query: DataQuery,
  fallbackSortKey?: string,
  defaultLimit = 40,
): Row[] {
  const { getRows } = useDataFiles();
  return useMemo(() => {
    if (Array.isArray(inline) && inline.length) return inline;
    if (!query.file) return [];
    const rows = getRows(query.file);
    if (!rows?.length) return [];
    const columns = Object.keys(rows[0] ?? {});
    const sortKey = resolveColumn(columns, query.sortBy ?? fallbackSortKey);
    const sorted = sortKey ? sortRows(rows, sortKey, query.sortDirection ?? "desc") : rows;
    const limit = query.limit && query.limit > 0 ? query.limit : defaultLimit;
    return sorted.slice(0, limit);
  }, [inline, query.file, query.sortBy, query.sortDirection, query.limit, fallbackSortKey, defaultLimit, getRows]);
}
