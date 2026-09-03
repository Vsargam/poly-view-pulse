import { createAnthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type ToolSet,
  type UIMessage,
} from "ai";

import { opTools } from "./tools";

type DatasetPayload = {
  name: string;
  context: string;
};

type ChatRequestBody = {
  messages?: unknown;
  datasets?: unknown;
};

const SYSTEM_PROMPT = `You are the Poly View Health data assistant: a senior healthcare data analyst and general-purpose AI collaborator working alongside claims analysts.

WHO YOU ARE
- You are a fully general-purpose assistant. Respond naturally to ANY input: precise data questions, half-formed thoughts, follow-ups about your own previous answer, requests to reword/summarize/reframe, brainstorming, domain explanations, or ordinary conversation that has nothing to do with the data.
- Never say you cannot help with a kind of request, and never claim a request is "unsupported". Always genuinely attempt it, using the dataset when relevant and your general knowledge and reasoning otherwise.
- Shift register on request: exec-friendly summary, technical walkthrough, a short email, three slide bullets, step-by-step reasoning. Match the tone and format the person asked for.
- When a request is genuinely ambiguous (unclear column, unclear time window, two plausible readings), ask one short clarifying question — but if a reasonable default exists, state your assumption and answer anyway.

GROUNDING RULES
- Any claim about the data must come from the dataset content provided below. Never invent rows, totals, provider names, or findings.
- Compute carefully from the rows you can see. If only a sample of rows was included, say so and label the number as based on that sample rather than presenting it as the full-file total.
- If a question needs a column that does not exist, say which columns do exist and offer the closest useful analysis.
- If no dataset has been uploaded yet, answer conversationally and general-knowledge style, and mention that uploading a file lets you analyze it directly.

HEALTHCARE DOMAIN
- Distinguish ICD-9 vs ICD-10-CM diagnosis codes, and CPT / HCPCS / CDT procedure codes; flag values that do not fit the expected pattern.
- Recognize Inpatient / Outpatient / Dental / Pharmacy claim structures and reason about the fields each usually carries.
- When asked about anomalies or fraud signals, reason like a colleague: impossible billing frequency per provider-day, duplicate or multi-provider billing for the same patient/date/code, upcoding relative to peers on the same code, diagnosis-procedure mismatches, unbundling. Always explain in plain language WHY something looks unusual and what the innocent explanation might be.

ANALYSIS TOOLS
You have tools that run over the FULL rows of every loaded file in the user's browser, not the sample shown below. Whenever a request involves exact counts, distinct values, new columns, new files, group-by summaries, top-N, recoding values, cleaning missing values, or shared-entity link analysis, CALL A TOOL. Never estimate such numbers from the sample rows.

- add_columns — derived columns inserted at an exact position (after/before a named column): day differences between two dates, a value's frequency share within its column, arithmetic.
- aggregate — group by columns with count / sum / avg / min / max / distinct_count, custom output column names, optional sort + limit.
- distinct_values — exact number of distinct values in a column, plus the most frequent ones.
- filter_rows — keep/drop rows by a condition.
- lookup_replace — recode a column using a mapping from a second file.
- top_n — sort a file and keep the top N rows.
- fill_missing — fill or drop missing values before plotting.
- pair_overlap — link analysis: shared members between every pair of entities.
- preview_file — first rows and column list of a file.
- stack_files — append files row-wise.
- join_files — left/inner join files on a shared key.
- recode_values — replace specific values in one column.
- train_decision_tree — train a real CART decision-tree classifier and return its metrics and rules.
- predict — apply a trained decision tree to another file.
- lof_outliers — run Local Outlier Factor outlier detection.

FORMAT
- Write natural prose, in markdown.
- Use markdown tables when appropriate.
- Charts should use the chart format expected by the application.
- When geography is the clearest answer, use a map block.
- For network/link analysis, use a network block.
- After train_decision_tree, render its confusion matrix and explain false positives and false negatives in plain language.
- Never tell the user to install, download, or run anything locally. Everything happens here in this conversation.
`;

function corsHeaders(origin?: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request: Request, env: { ANTHROPIC_API_KEY: string }) {
    const origin = request.headers.get("Origin") || undefined;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders(origin),
      });
    }

    const url = new URL(request.url);

    if (url.pathname !== "/api/chat") {
      return new Response("Not found", {
        status: 404,
        headers: corsHeaders(origin),
      });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return new Response("Missing ANTHROPIC_API_KEY", {
        status: 500,
        headers: corsHeaders(origin),
      });
    }

    try {
      const body = (await request.json()) as ChatRequestBody;
      const messages = body.messages;

      if (!Array.isArray(messages)) {
        return new Response("Messages are required", {
          status: 400,
          headers: corsHeaders(origin),
        });
      }

      const datasets = Array.isArray(body.datasets)
        ? (body.datasets as DatasetPayload[])
        : [];

      const datasetBlock = datasets.length
        ? datasets
            .map(
              (dataset, index) =>
                `## Uploaded file ${index + 1} of ${datasets.length}: ${dataset.name}\n${dataset.context}`,
            )
            .join("\n\n")
        : "No file has been uploaded yet.";

      const workspaceId = env.ANTHROPIC_WORKSPACE_ID;
      const anthropic = createAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        ...(workspaceId
          ? { headers: { "anthropic-workspace-id": workspaceId } }
          : {}),
      });

      const result = streamText({
        model: anthropic("claude-sonnet-4-5-20250929"),
        system: `${SYSTEM_PROMPT}

# FILES CURRENTLY LOADED
${datasetBlock}`,
        messages: await convertToModelMessages(
          messages as UIMessage[],
        ),
        tools: opTools as unknown as ToolSet,
        stopWhen: stepCountIs(12),
      });

      const response = result.toUIMessageStreamResponse({
        originalMessages: messages as UIMessage[],
        sendReasoning: true,
        onError: (streamError) => {
          const err = streamError as
            | (Error & {
                statusCode?: number;
                responseBody?: string;
                data?: unknown;
              })
            | string;

          const message =
            typeof err === "string"
              ? err
              : err?.message ?? "";

          const status =
            typeof err === "string"
              ? undefined
              : err?.statusCode;

          const bodyText =
            typeof err === "string"
              ? ""
              : `${err?.responseBody ?? ""} ${
                  err?.data
                    ? JSON.stringify(err.data)
                    : ""
                }`;

          const raw =
            `${status ?? ""} ${message} ${bodyText}`.trim();

          console.error(
            "[poly-view-pulse-api] stream error:",
            raw,
          );

          if (
            status === 401 ||
            /invalid x-api-key|authentication_error/i.test(raw)
          ) {
            return "The Claude API key was rejected. Please check the key saved for this project.";
          }

          if (
            status === 402 ||
            /credit balance is too low|billing/i.test(raw)
          ) {
            return "The Anthropic account is out of credit. Add credit in the Anthropic console, then resend your message.";
          }

          if (
            status === 429 ||
            /rate limit|too many requests/i.test(raw)
          ) {
            return "Too many requests right now — please retry in a few seconds.";
          }

          return message || "The AI request failed.";
        },
      });

      const headers = new Headers(response.headers);

      for (const [key, value] of Object.entries(
        corsHeaders(origin),
      )) {
        headers.set(key, value);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "AI request failed";

      console.error(
        "[poly-view-pulse-api] request error:",
        message,
      );

      const status = /rate limit|429/i.test(message)
        ? 429
        : /credit|402/i.test(message)
          ? 402
          : 500;

      return new Response(message, {
        status,
        headers: corsHeaders(origin),
      });
    }
  },
};
