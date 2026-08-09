import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { codingHints, claimTypeGuess } from "@/lib/dataset";
import { parseTabularText } from "../parse";
import { describeDetectedColumns } from "../anomalies";

export default defineTool({
  name: "profile_dataset",
  title: "Profile a claims dataset",
  description:
    "Profile a healthcare claims dataset provided as CSV, TSV, or JSON text. Returns row/column counts, per-column types, missing rates, distinct counts, ranges, top values, detected clinical coding systems (ICD-9/ICD-10, CPT, HCPCS, CDT), and the likely claim structure.",
  inputSchema: {
    name: z.string().trim().min(1).describe("A label for the dataset, e.g. the file name."),
    content: z
      .string()
      .min(1)
      .describe("The dataset itself as CSV, TSV, or JSON text, including a header row for CSV/TSV."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ name, content }) => {
    const dataset = parseTabularText(name, content);
    const hints = codingHints(dataset);

    const summary = [
      `Dataset: ${dataset.name}`,
      `Rows parsed: ${dataset.rowCount}`,
      `Columns: ${dataset.columns.length}`,
      `Likely claim structure: ${claimTypeGuess(dataset)}`,
      `Detected analysis columns — ${describeDetectedColumns(dataset)}`,
      "",
      "Columns:",
      ...dataset.columns.map((column) => {
        const parts = [`- ${column.name} [${column.inferredType}] missing=${column.missingPct}% distinct=${column.distinctCount}`];
        if (column.mean !== undefined) parts.push(`min=${column.min} max=${column.max} mean=${column.mean}`);
        else if (column.min !== undefined) parts.push(`range=${column.min}..${column.max}`);
        if (column.topValues?.length)
          parts.push(`top: ${column.topValues.slice(0, 6).map((t) => `${t.value}(${t.count})`).join(", ")}`);
        return parts.join(" | ");
      }),
      "",
      hints.length ? `Coding hints:\n${hints.map((h) => `- ${h}`).join("\n")}` : "Coding hints: none detected.",
    ].join("\n");

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        name: dataset.name,
        rowCount: dataset.rowCount,
        claimStructure: claimTypeGuess(dataset),
        codingHints: hints,
        columns: dataset.columns.map((c) => ({
          name: c.name,
          type: c.inferredType,
          missingPct: c.missingPct,
          distinctCount: c.distinctCount,
        })),
      },
    };
  },
});
