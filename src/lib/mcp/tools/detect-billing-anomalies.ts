import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { parseTabularText } from "../parse";
import { detectAnomalies, describeDetectedColumns } from "../anomalies";

export default defineTool({
  name: "detect_billing_anomalies",
  title: "Detect billing anomalies",
  description:
    "Run deterministic billing-anomaly checks over a healthcare claims dataset provided as CSV, TSV, or JSON text: duplicate patient/date/procedure billing, implausible claim volume per provider-day, many providers on one patient-day, amount outliers versus peers on the same procedure code, and sparse key columns. Each finding includes plain-language reasoning and possible innocent explanations.",
  inputSchema: {
    name: z.string().trim().min(1).describe("A label for the dataset, e.g. the file name."),
    content: z
      .string()
      .min(1)
      .describe("The claims data as CSV, TSV, or JSON text, including a header row for CSV/TSV."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ name, content }) => {
    let dataset;
    try {
      dataset = parseTabularText(name, content);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : "Could not parse the provided data.");
    }

    const findings = detectAnomalies(dataset);
    const header = [
      `Anomaly review of ${dataset.name} (${dataset.rowCount} rows analyzed).`,
      `Detected analysis columns — ${describeDetectedColumns(dataset)}`,
      "",
    ].join("\n");

    const body = findings.length
      ? findings
          .map((f) => `## ${f.kind}\n${f.detail}\nExamples:\n${f.examples.map((e) => `- ${e}`).join("\n")}`)
          .join("\n\n")
      : "No anomalies triggered the checks on these rows. Note that checks depend on recognizable provider, patient, date, procedure, and amount columns.";

    return {
      content: [{ type: "text", text: header + body }],
      structuredContent: { rowsAnalyzed: dataset.rowCount, findings },
    };
  },
});
