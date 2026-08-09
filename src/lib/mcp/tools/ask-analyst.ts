import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { datasetContext } from "@/lib/dataset";
import { parseTabularText } from "../parse";

const SYSTEM_PROMPT = `You are the Poly View Health data assistant: a senior healthcare claims analyst.

- Any claim about the data must come from the dataset content provided. Never invent rows, totals, provider names, or findings.
- If only a sample of rows was included, label numbers as based on that sample rather than the full file.
- If a question needs a column that does not exist, say which columns do exist and offer the closest useful analysis.
- Distinguish ICD-9 vs ICD-10-CM diagnosis codes and CPT / HCPCS / CDT procedure codes; flag values that do not fit the expected pattern.
- For anomaly or fraud questions, reason like a colleague: impossible billing frequency per provider-day, duplicate or multi-provider billing for the same patient/date/code, upcoding relative to peers, diagnosis-procedure mismatches, unbundling. Explain in plain language why something looks unusual and what the innocent explanation might be.
- Answer in tight markdown prose; use a markdown table when a table is the clearest answer. No boilerplate preamble.`;

type AnthropicResponse = { content?: { type: string; text?: string }[] };

export default defineTool({
  name: "ask_analyst",
  title: "Ask the claims analyst",
  description:
    "Ask a natural-language question about a healthcare claims dataset and get a reasoned analyst answer. Provide the dataset as CSV, TSV, or JSON text along with your question. Handles trend questions, code-level breakdowns, anomaly reasoning, plain-English explanations, and summaries at whatever level of detail you ask for.",
  inputSchema: {
    question: z.string().trim().min(1).describe("The question to answer about the data."),
    name: z.string().trim().min(1).describe("A label for the dataset, e.g. the file name."),
    content: z
      .string()
      .min(1)
      .describe("The dataset as CSV, TSV, or JSON text, including a header row for CSV/TSV."),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ question, name, content }) => {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new ToolError("The analyst model is not configured for this app.");

    let dataset;
    try {
      dataset = parseTabularText(name, content);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : "Could not parse the provided data.");
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 2048,
        system: `${SYSTEM_PROMPT}\n\n# DATA AVAILABLE TO YOU\n${datasetContext(dataset, 60_000)}`,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ToolError(`The analyst model returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as AnthropicResponse;
    const answer = (payload.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!answer) throw new ToolError("The analyst model returned an empty answer.");

    return {
      content: [{ type: "text", text: answer }],
      structuredContent: { rowsAnalyzed: dataset.rowCount, answer },
    };
  },
});
