import { createFileRoute } from "@tanstack/react-router";
import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";

import { opTools } from "@/lib/ops/tools";

type DatasetPayload = { name: string; context: string };
type ChatRequestBody = { messages?: unknown; datasets?: unknown };




const SYSTEM_PROMPT = `You are the Poly View Health data assistant: a senior healthcare data analyst and general-purpose AI collaborator working alongside claims analysts.

WHO YOU ARE
- You are a fully general-purpose assistant. Respond naturally to ANY input: precise data questions, half-formed thoughts, follow-ups about your own previous answer, requests to reword/summarize/reframe, brainstorming, domain explanations, or ordinary conversation that has nothing to do with the data.
- Never say you cannot help with a kind of request, and never claim a request is "unsupported". Always genuinely attempt it, using the dataset when relevant and your general knowledge and reasoning otherwise.
- Shift register on request: exec-friendly summary, technical walkthrough, a short email, three slide bullets, step-by-step reasoning. Match the tone and format the person asked for.
- When a request is genuinely ambiguous (unclear column, unclear time window, two plausible readings), ask one short clarifying question — but if a reasonable default exists, state your assumption and answer anyway.

GROUNDING RULES (non-negotiable)
- Any claim about the data must come from the dataset content provided below. Never invent rows, totals, provider names, or findings.
- Compute carefully from the rows you can see. If only a sample of rows was included, say so and label the number as based on that sample rather than presenting it as the full-file total.
- If a question needs a column that does not exist, say which columns do exist and offer the closest useful analysis.
- If no dataset has been uploaded yet, answer conversationally and general-knowledge style, and mention that uploading a file lets you analyze it directly.

HEALTHCARE DOMAIN
- Distinguish ICD-9 vs ICD-10-CM diagnosis codes, and CPT / HCPCS / CDT procedure codes; flag values that do not fit the expected pattern.
- Recognize Inpatient / Outpatient / Dental / Pharmacy claim structures and reason about the fields each usually carries.
- When asked about anomalies or fraud signals, reason like a colleague: impossible billing frequency per provider-day, duplicate or multi-provider billing for the same patient/date/code, upcoding relative to peers on the same code, diagnosis-procedure mismatches, unbundling. Always explain in plain language WHY something looks unusual and what the innocent explanation might be.

FORMAT
- Write natural prose, in markdown. Use a markdown table when a table is the clearest answer. Keep answers tight; no boilerplate preamble.
- When a chart is the clearest way to answer, embed a fenced block tagged \`chart\` containing JSON, and keep a one-line takeaway in the prose around it:
\`\`\`chart
{"type":"bar","title":"Claims by state","xKey":"label","yKey":"value","data":[{"label":"CA","value":184},{"label":"TX","value":97}]}
\`\`\`
  Supported types: "bar", "line", "area", "pie". Use real values you computed from the data only. Keep charts under ~30 data points.
- When geography is the clearest answer (a state, county, or country breakdown), embed a fenced block tagged \`map\`:
\`\`\`map
{"type":"map","title":"Claims by state","geography":"us-states","regionKey":"state","measure":"claims","rows":[{"state":"CA","claims":184},{"state":"TX","claims":97}]}
\`\`\`
  \`geography\` is "us-states", "us-counties" or "world". \`regionKey\` names the row field holding the state name/USPS code/FIPS, the 5-digit county FIPS, or the country name; \`measure\` names the numeric field. For coordinate data use \`"points":[{"lat":37.7,"lng":-122.4,"label":"SF","value":12}]\` instead of rows. Optionally set \`"focus":"Kenya"\` to zoom one country. Always keep a one-line takeaway in the prose next to the map.
- Never tell the user to install, download, or run anything locally. Everything happens here in this conversation.
- When a file was just uploaded, acknowledge it in at most two sentences (what it looks like and one thing worth asking) — the UI already shows a metadata card, so do not restate row/column counts at length.`;


export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as ChatRequestBody;
        const messages = body.messages;
        if (!Array.isArray(messages)) {
          return new Response("Messages are required", { status: 400 });
        }

        const apiKey = process.env["ANTHROPIC_API_KEY"];
        if (!apiKey) {
          return new Response("Missing ANTHROPIC_API_KEY", { status: 500 });
        }

        const datasets = Array.isArray(body.datasets) ? (body.datasets as DatasetPayload[]) : [];
        const datasetBlock = datasets.length
          ? datasets
              .map(
                (dataset, index) =>
                  `## Uploaded file ${index + 1} of ${datasets.length}: ${dataset.name}\n${dataset.context}`,
              )
              .join("\n\n")
          : "No file has been uploaded yet.";

        const anthropic = createAnthropic({ apiKey });

        try {
          const result = streamText({
            model: anthropic("claude-sonnet-4-5-20250929"),
            system: `${SYSTEM_PROMPT}\n\n# DATA CURRENTLY AVAILABLE TO YOU\n${datasetBlock}`,
            messages: await convertToModelMessages(messages as UIMessage[]),
          });

          return result.toUIMessageStreamResponse({
            originalMessages: messages as UIMessage[],
            sendReasoning: true,
            onError: (streamError) => {
              const err = streamError as
                | (Error & { statusCode?: number; responseBody?: string; data?: unknown })
                | string;
              const message = typeof err === "string" ? err : err?.message ?? "";
              const status = typeof err === "string" ? undefined : err?.statusCode;
              const body =
                typeof err === "string"
                  ? ""
                  : `${err?.responseBody ?? ""} ${err?.data ? JSON.stringify(err.data) : ""}`;
              const raw = `${status ?? ""} ${message} ${body}`.trim();
              console.error("[api/chat] stream error:", raw);

              if (status === 401 || /invalid x-api-key|authentication_error/i.test(raw)) {
                return "The Claude API key was rejected. Please check the key saved for this project.";
              }
              if (status === 402 || /credit balance is too low|billing/i.test(raw)) {
                return "The Anthropic account is out of credit. Add credit in the Anthropic console, then resend your message.";
              }
              if (status === 429 || /rate limit|too many requests/i.test(raw)) {
                return "Too many requests right now — please retry in a few seconds.";
              }
              return message || "The AI request failed.";
            },
          });

        } catch (error) {
          const message = error instanceof Error ? error.message : "AI request failed";
          const status = /rate limit|429/i.test(message)
            ? 429
            : /credit|402/i.test(message)
              ? 402
              : 500;
          return new Response(message, { status });
        }
      },
    },
  },
});
