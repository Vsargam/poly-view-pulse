import Papa from "papaparse";
import { buildDataset, type Dataset, type Row } from "@/lib/dataset";

/** Parse CSV / TSV / JSON text that an MCP caller sent inline, then profile it. */
export function parseTabularText(name: string, content: string): Dataset {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("The provided data was empty.");

  let rows: Row[];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    rows = Array.isArray(parsed)
      ? (parsed as Row[])
      : Array.isArray((parsed as Row | undefined)?.["data"])
        ? ((parsed as { data: Row[] }).data)
        : [parsed as Row];
  } else {
    const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
    const tabs = (firstLine.match(/\t/g) ?? []).length;
    const commas = (firstLine.match(/,/g) ?? []).length;
    const result = Papa.parse<Row>(trimmed, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      ...(tabs > commas ? { delimiter: "\t" } : {}),
    });
    rows = (result.data ?? []).filter((row) => row && typeof row === "object");
  }

  if (!rows.length) throw new Error("No data rows could be parsed from the provided content.");
  return buildDataset(name, rows, rows.length);
}
