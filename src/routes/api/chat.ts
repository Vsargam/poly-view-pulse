import { createFileRoute } from "@tanstack/react-router";
import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import {
  createLovableAiGatewayRunIdFetch,
  getLovableAiGatewayResponseHeaders,
  getLovableAiGatewayRunId,
  withLovableAiGatewayRunIdHeader,
} from "@/lib/ai-gateway.server";

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
- Never tell the user to install, download, or run anything locally. Everything happens here in this conversation.`;

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as ChatRequestBody;
        const messages = body.messages;
        if (!Array.isArray(messages)) {
          return new Response("Messages are required", { status: 400 });
        }

        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) {
          return new Response("Missing LOVABLE_API_KEY", { status: 500 });
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

        const initialRunId = getLovableAiGatewayRunId(request);
        const runIdFetch = createLovableAiGatewayRunIdFetch(initialRunId);
        const lovable = createOpenAI({
          baseURL: "https://ai.gateway.lovable.dev/v1",
          apiKey,
          headers: {
            "Lovable-API-Key": apiKey,
            "X-Lovable-AIG-SDK": "vercel-ai-sdk",
          },
          fetch: runIdFetch.fetch,
        });

        try {
          const result = streamText({
            model: lovable.responses("openai/gpt-5.6-sol"),
            system: `${SYSTEM_PROMPT}\n\n# DATA CURRENTLY AVAILABLE TO YOU\n${datasetBlock}`,
            messages: await convertToModelMessages(messages as UIMessage[]),
            providerOptions: {
              openai: {
                forceReasoning: true,
                reasoningEffort: "medium",
                reasoningSummary: "auto",
                store: false,
                include: ["reasoning.encrypted_content"],
              },
            },
          });

          const response = result.toUIMessageStreamResponse({
            originalMessages: messages as UIMessage[],
            sendReasoning: true,
            onError: (streamError) => {
              const raw =
                streamError instanceof Error
                  ? streamError.message
                  : typeof streamError === "string"
                    ? streamError
                    : JSON.stringify(streamError);
              console.error("[api/chat] stream error:", raw);
              if (/402|not enough credits|payment_required/i.test(raw)) {
                return "This workspace is out of AI credits, so the assistant cannot answer right now. Add credits in workspace billing settings and try again.";
              }
              if (/429|rate limit/i.test(raw)) {
                return "Too many requests right now — please retry in a few seconds.";
              }
              return raw || "The AI request failed.";
            },
            headers: getLovableAiGatewayResponseHeaders(undefined, {
              ...(initialRunId ? { "X-Lovable-AIG-Run-ID": initialRunId } : {}),
            }),
          });


          return withLovableAiGatewayRunIdHeader(response, runIdFetch);
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
