import { useChat } from "@ai-sdk/react";
import { createFileRoute } from "@tanstack/react-router";
import { DefaultChatTransport, type UIMessage } from "ai";
import { FileSpreadsheet, Paperclip, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import logo from "@/assets/polyview-logo.png";
import { AssistantAnswer } from "@/components/AssistantAnswer";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { buildDataset, datasetContext, parseFile, type Dataset } from "@/lib/dataset";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Poly View Health — Conversational Claims Analyst" },
      {
        name: "description",
        content:
          "Upload a claims file and ask anything in plain English. Poly View Health answers with grounded analysis, tables and charts in one running chat.",
      },
      { property: "og:title", content: "Poly View Health — Conversational Claims Analyst" },
      {
        property: "og:description",
        content:
          "Ask any question about your healthcare claims data in plain English and get reasoned answers, tables and charts inline.",
      },
    ],
  }),
  component: Index,
});

const MESSAGES_KEY = "pvh.chat.messages.v1";
const DATASETS_KEY = "pvh.chat.datasets.v1";

type StoredDataset = Pick<Dataset, "id" | "name" | "uploadedAt" | "rowCount" | "fullRowsIncluded"> & {
  columnCount: number;
  context: string;
};

const readStored = <T,>(key: string, fallback: T): T => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeStored = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full — history stays in memory for this session */
  }
};

const messageText = (message: UIMessage) =>
  message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

const reasoningText = (message: UIMessage) =>
  message.parts
    .map((part) => (part.type === "reasoning" ? part.text : ""))
    .join("")
    .trim();

function Index() {
  const [hydrated, setHydrated] = useState(false);
  const [datasets, setDatasets] = useState<StoredDataset[]>([]);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [parsing, setParsing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setInitialMessages(readStored<UIMessage[]>(MESSAGES_KEY, []));
    setDatasets(readStored<StoredDataset[]>(DATASETS_KEY, []));
    setHydrated(true);
  }, []);

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);

  const { messages, setMessages, sendMessage, status, error } = useChat({
    id: "poly-view-health",
    transport,
    onError: (chatError) => {
      const message = chatError.message || "Something went wrong talking to the assistant.";
      toast.error(
        /429|rate limit/i.test(message)
          ? "Too many requests right now — try again in a moment."
          : /402|credit/i.test(message)
            ? "AI credits are exhausted for this workspace."
            : message,
      );
    },
  });

  // Restore persisted thread once localStorage has been read.
  useEffect(() => {
    if (hydrated && initialMessages.length) setMessages(initialMessages);
  }, [hydrated, initialMessages, setMessages]);

  // Persist thread on every change.
  useEffect(() => {
    if (!hydrated) return;
    if (messages.length) writeStored(MESSAGES_KEY, messages);
  }, [hydrated, messages]);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  useEffect(() => {
    if (hydrated) focusInput();
  }, [hydrated, focusInput]);

  useEffect(() => {
    if (status === "ready") focusInput();
  }, [status, focusInput]);

  const datasetPayload = useMemo(
    () => datasets.map((dataset) => ({ name: dataset.name, context: dataset.context })),
    [datasets],
  );

  const busy = status === "submitted" || status === "streaming";

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setInput("");
      void sendMessage({ text: trimmed }, { body: { datasets: datasetPayload } });
      focusInput();
    },
    [busy, datasetPayload, focusInput, sendMessage],
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      setParsing(true);
      try {
        const { rows, rowCount } = await parseFile(file);
        if (!rowCount) throw new Error("No rows could be read from that file.");
        const dataset = buildDataset(file.name, rows, rowCount);
        const stored: StoredDataset = {
          id: dataset.id,
          name: dataset.name,
          uploadedAt: dataset.uploadedAt,
          rowCount: dataset.rowCount,
          fullRowsIncluded: dataset.fullRowsIncluded,
          columnCount: dataset.columns.length,
          context: datasetContext(dataset),
        };
        const next = [...datasets, stored];
        setDatasets(next);
        writeStored(DATASETS_KEY, next);

        void sendMessage(
          {
            text: `I just uploaded a file: "${file.name}". Briefly acknowledge what you received — row and column count, what the columns look like, the likely claim type — and suggest two or three things worth asking about it.`,
          },
          { body: { datasets: next.map((d) => ({ name: d.name, context: d.context })) } },
        );
      } catch (uploadError) {
        toast.error(
          uploadError instanceof Error ? uploadError.message : "That file could not be read.",
        );
      } finally {
        setParsing(false);
        if (fileRef.current) fileRef.current.value = "";
        focusInput();
      }
    },
    [datasets, focusInput, sendMessage],
  );

  const removeDataset = (id: string) => {
    const next = datasets.filter((dataset) => dataset.id !== id);
    setDatasets(next);
    writeStored(DATASETS_KEY, next);
  };

  const clearThread = () => {
    setMessages([]);
    writeStored(MESSAGES_KEY, []);
    toast.success("Conversation cleared.");
    focusInput();
  };

  return (
    <main className="mx-auto flex h-screen w-full max-w-4xl flex-col px-4 pb-4">
      <header className="flex items-center gap-3 border-b border-border py-4">
        <img src={logo} alt="Poly View Health" width={36} height={36} className="h-9 w-9" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight">Poly View Health</h1>
          <p className="truncate text-xs text-muted-foreground">
            Conversational claims analyst — ask anything, in plain English
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.tab,.json,.xlsx,.xls"
          className="hidden"
          onChange={(event) => void handleFiles(event.target.files)}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={parsing}
        >
          <Paperclip className="mr-2 h-4 w-4" />
          {parsing ? "Reading…" : "Upload data"}
        </Button>
        {messages.length > 0 ? (
          <Button variant="ghost" size="icon-sm" title="Clear conversation" onClick={clearThread}>
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : null}
      </header>

      {datasets.length > 0 ? (
        <div className="flex flex-wrap gap-2 py-3">
          {datasets.map((dataset) => (
            <span
              key={dataset.id}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-chart-2" />
              <span className="max-w-[15rem] truncate font-medium text-foreground">
                {dataset.name}
              </span>
              <span>
                {dataset.rowCount.toLocaleString()} rows · {dataset.columnCount} cols
              </span>
              <button
                type="button"
                onClick={() => removeDataset(dataset.id)}
                aria-label={`Remove ${dataset.name}`}
                className="rounded-full p-0.5 transition-colors hover:bg-secondary"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-6 px-0">
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={
                <img src={logo} alt="" width={56} height={56} className="h-14 w-14" loading="lazy" />
              }
              title="Ask about your claims data"
              description="Upload a CSV, Excel, JSON or TSV file, then ask anything — a number, a chart, a cleanup, an anomaly check, or just help thinking about what to look at."
            />
          ) : null}

          {messages.map((message) => {
            const text = messageText(message);
            const reasoning = reasoningText(message);
            return (
              <Message key={message.id} from={message.role}>
                <MessageContent>
                  {message.role === "assistant" ? (
                    <>
                      {reasoning && !text ? (
                        <p className="text-xs italic text-muted-foreground">{reasoning.slice(-400)}</p>
                      ) : null}
                      {text ? <AssistantAnswer text={text} /> : null}
                    </>
                  ) : (
                    <p className="whitespace-pre-wrap">{text}</p>
                  )}
                </MessageContent>
              </Message>
            );
          })}

          {status === "submitted" ? (
            <Message from="assistant">
              <MessageContent>
                <Shimmer>Thinking…</Shimmer>
              </MessageContent>
            </Message>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {error ? (
        <p className="pb-2 text-xs text-destructive">
          {error.message || "The last request failed. Try again."}
        </p>
      ) : null}

      <PromptInput
        onSubmit={(_message, event) => {
          event.preventDefault();
          submit(input);
        }}
      >
        <PromptInputTextarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={
            datasets.length
              ? "Ask anything — “which providers bill far above their peers for the same CPT code?”"
              : "Ask anything, or upload a file to analyze"
          }
        />
        <PromptInputFooter className="justify-between">
          <span className="text-[11px] text-muted-foreground">
            {datasets.length
              ? `Grounded in ${datasets.length} uploaded file${datasets.length > 1 ? "s" : ""}`
              : "No file uploaded yet"}
          </span>
          <PromptInputSubmit status={status} disabled={!input.trim() && !busy} />
        </PromptInputFooter>
      </PromptInput>
    </main>
  );
}
