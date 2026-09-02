import { useChat } from "@ai-sdk/react";
import { createFileRoute } from "@tanstack/react-router";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { Loader2, Merge, Paperclip, RotateCcw, Scissors, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import logo from "@/assets/polyview-logo.png";
import { AssistantAnswer } from "@/components/AssistantAnswer";
import { DatasetCard, type DatasetCardInfo } from "@/components/DatasetCard";
import { ThreadSidebar, type ThreadSummary } from "@/components/ThreadSidebar";
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
import { DataFilesContext } from "@/lib/ops/files-context";
import { runOpTool, type FileStore } from "@/lib/ops/execute";
import { toCsv, type Table } from "@/lib/ops/engine";
import {
  buildDataset,
  claimTypeGuess,
  codingHints,
  datasetContext,
  parseFile,
  type Dataset,
  type Row,
} from "@/lib/dataset";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Poly View Health — Conversational Claims Analyst" },
      {
        name: "description",
        content:
          "Upload claims files and ask anything in plain English. Poly View Health answers with grounded analysis, tables, charts and maps in one running chat.",
      },
      { property: "og:title", content: "Poly View Health — Conversational Claims Analyst" },
      {
        property: "og:description",
        content:
          "Ask any question about your healthcare claims data in plain English and get reasoned answers, tables, charts and maps inline.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const THREADS_KEY = "pvh.chat.threads.v1";
const ACTIVE_KEY = "pvh.chat.active.v1";
const MAX_THREADS = 40;
const MAX_SPLIT_GROUPS = 12;
const REQUEST_TIMEOUT_MS = 120_000;
const FILE_PARSE_TIMEOUT_MS = 60_000;
const CHAT_API_URL =
  import.meta.env.VITE_CHAT_API_URL ||
  "https://poly-view-pulse-api.vsargam7.workers.dev/api/chat";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => window.clearTimeout(timeout));
  });
}

type StoredDataset = Pick<
  Dataset,
  "id" | "name" | "uploadedAt" | "rowCount" | "fullRowsIncluded"
> & {
  columnCount: number;
  columnNames: string[];
  claimType: string;
  hints: string[];
  derivedFrom?: string;
  context: string;
};

type StoredThread = {
  id: string;
  title: string;
  updatedAt: number;
  messages: UIMessage[];
  datasets: StoredDataset[];
};

type PendingFile = { id: string; name: string; error?: string };

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const readThreads = (): StoredThread[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(THREADS_KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredThread[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeThreads = (threads: StoredThread[]) => {
  try {
    window.localStorage.setItem(THREADS_KEY, JSON.stringify(threads.slice(0, MAX_THREADS)));
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

const titleFrom = (messages: UIMessage[]) => {
  const first = messages.find((message) => message.role === "user");
  const text = first ? messageText(first) : "";
  if (!text) return "New chat";
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
};

const toStored = (dataset: Dataset, derivedFrom?: string): StoredDataset => ({
  id: dataset.id,
  name: dataset.name,
  uploadedAt: dataset.uploadedAt,
  rowCount: dataset.rowCount,
  fullRowsIncluded: dataset.fullRowsIncluded,
  columnCount: dataset.columns.length,
  columnNames: dataset.columns.map((column) => column.name),
  claimType: claimTypeGuess(dataset),
  hints: codingHints(dataset),
  ...(derivedFrom ? { derivedFrom } : {}),
  context: datasetContext(dataset),
});

function Index() {
  const [hydrated, setHydrated] = useState(false);
  const [threads, setThreads] = useState<StoredThread[]>([]);
  const [activeId, setActiveId] = useState("pending");
  const [datasets, setDatasets] = useState<StoredDataset[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [input, setInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const [splitTarget, setSplitTarget] = useState("");
  const [splitColumn, setSplitColumn] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Row data for this session only, so files can be merged and split client-side. */
  const rowsRef = useRef<Map<string, Row[]>>(new Map());

  const payloadRef = useRef<{ name: string; context: string }[]>([]);

  /** Always send the current file profiles, including tool-generated files, on
   * every request — including the automatic follow-up after a tool result. */
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: CHAT_API_URL,
        fetch: async (input, init) => {
          const controller = new AbortController();
          const callerSignal = init?.signal;
          const abort = () => controller.abort(callerSignal?.reason);
          if (callerSignal?.aborted) abort();
          else callerSignal?.addEventListener("abort", abort, { once: true });
          const timeout = window.setTimeout(
            () => controller.abort(new Error("Request timed out")),
            REQUEST_TIMEOUT_MS,
          );
          try {
            return await fetch(input, { ...init, signal: controller.signal });
          } finally {
            window.clearTimeout(timeout);
            callerSignal?.removeEventListener("abort", abort);
          }
        },
        prepareSendMessagesRequest: ({ messages: outgoing, body }) => ({
          body: { ...body, messages: outgoing, datasets: payloadRef.current },
        }),
      }),
    [],
  );

  /** Names of files the tools generated, so the model and charts can use them. */
  const datasetsRef = useRef<StoredDataset[]>([]);
  useEffect(() => {
    datasetsRef.current = datasets;
  }, [datasets]);

  const norm = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/\.(csv|tsv|json|xlsx|xls)$/i, "");

  const fileStore = useMemo<FileStore>(
    () => ({
      find: (name) => {
        const wanted = norm(name ?? "");
        const list = datasetsRef.current.filter((dataset) => rowsRef.current.has(dataset.id));
        const hit =
          list.find((dataset) => norm(dataset.name) === wanted) ??
          list.find((dataset) => norm(dataset.name).includes(wanted) && wanted.length > 2) ??
          list.find((dataset) => wanted.includes(norm(dataset.name)));
        if (!hit) return null;
        return { id: hit.id, name: hit.name, rows: rowsRef.current.get(hit.id) ?? [] };
      },
      list: () =>
        datasetsRef.current
          .filter((dataset) => rowsRef.current.has(dataset.id))
          .map((dataset) => ({ name: dataset.name, rows: dataset.rowCount })),
      add: (name, table: Table, note, sourceName) => {
        const taken = new Set(datasetsRef.current.map((dataset) => dataset.name));
        let finalName = name;
        let counter = 2;
        while (taken.has(finalName)) {
          finalName = name.replace(/(\.[a-z]+)?$/i, (ext) => `_${counter}${ext || ""}`);
          counter += 1;
        }
        const rows = table.rows;
        const dataset = buildDataset(finalName, rows, rows.length);
        rowsRef.current.set(dataset.id, rows);
        const stored = { ...toStored(dataset, note), generated: true };
        datasetsRef.current = [...datasetsRef.current, stored];
        setDatasets(datasetsRef.current);
        void sourceName;
        return finalName;
      },
    }),
    [],
  );

  const { messages, setMessages, sendMessage, regenerate, status, error, stop, addToolResult } =
    useChat({
      id: activeId,
      transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall: async ({ toolCall }) => {
        try {
          const output = await withTimeout(
            runOpTool(toolCall.toolName, toolCall.input, fileStore),
            REQUEST_TIMEOUT_MS,
            "This analysis step took too long. Try a smaller file or split the request into smaller steps.",
          );
          await addToolResult({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output });
        } catch (toolError) {
          await addToolResult({
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            output: {
              error: toolError instanceof Error ? toolError.message : "The analysis step failed.",
            },
          });
        }
      },
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

  // On load: keep history, but start a fresh chat unless this browser tab was
  // already in the middle of one (survives reload, resets when the tab closes).
  useEffect(() => {
    const stored = readThreads();
    setThreads(stored);

    const sessionId = window.sessionStorage.getItem(ACTIVE_KEY);
    const resumed = sessionId ? stored.find((thread) => thread.id === sessionId) : undefined;

    if (resumed) {
      setActiveId(resumed.id);
      setDatasets(resumed.datasets ?? []);
      setMessages(resumed.messages ?? []);
    } else {
      const id = newId();
      window.sessionStorage.setItem(ACTIVE_KEY, id);
      setActiveId(id);
      setDatasets([]);
      setMessages([]);
    }
    setHydrated(true);
  }, [setMessages]);

  useEffect(() => {
    if (!hydrated || activeId === "pending") return;
    if (!messages.length && !datasets.length) return;
    setThreads((current) => {
      const rest = current.filter((thread) => thread.id !== activeId);
      const next: StoredThread[] = [
        { id: activeId, title: titleFrom(messages), updatedAt: Date.now(), messages, datasets },
        ...rest,
      ];
      writeThreads(next);
      return next;
    });
  }, [hydrated, activeId, messages, datasets]);

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

  useEffect(() => {
    payloadRef.current = datasetPayload;
  }, [datasetPayload]);

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

  const startNewChat = useCallback(() => {
    const id = newId();
    window.sessionStorage.setItem(ACTIVE_KEY, id);
    setActiveId(id);
    setDatasets([]);
    setPending([]);
    rowsRef.current = new Map();
    setMessages([]);
    setInput("");
    focusInput();
  }, [focusInput, setMessages]);

  const selectThread = useCallback(
    (id: string) => {
      const thread = threads.find((item) => item.id === id);
      if (!thread) return;
      window.sessionStorage.setItem(ACTIVE_KEY, id);
      setActiveId(id);
      setDatasets(thread.datasets ?? []);
      setPending([]);
      setMessages(thread.messages ?? []);
      setInput("");
      focusInput();
    },
    [focusInput, setMessages, threads],
  );

  const deleteThread = useCallback(
    (id: string) => {
      setThreads((current) => {
        const next = current.filter((thread) => thread.id !== id);
        writeThreads(next);
        return next;
      });
      if (id === activeId) startNewChat();
    },
    [activeId, startNewChat],
  );

  const handleFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const list = files ? Array.from(files) : [];
      if (!list.length) return;

      const queued: PendingFile[] = list.map((file) => ({ id: newId(), name: file.name }));
      setPending((current) => [...current, ...queued]);

      const added: StoredDataset[] = [];

      for (const [index, file] of list.entries()) {
        const queuedId = queued[index]!.id;
        try {
          const { rows, rowCount } = await withTimeout(
            parseFile(file),
            FILE_PARSE_TIMEOUT_MS,
            "Reading this file took too long. Try a smaller file or split it into parts.",
          );
          if (!rowCount) throw new Error("No rows could be read from that file.");
          const dataset = buildDataset(file.name, rows, rowCount);
          rowsRef.current.set(dataset.id, rows);
          added.push(toStored(dataset));
          setPending((current) => current.filter((item) => item.id !== queuedId));
        } catch (uploadError) {
          const message =
            uploadError instanceof Error ? uploadError.message : "That file could not be read.";
          setPending((current) =>
            current.map((item) => (item.id === queuedId ? { ...item, error: message } : item)),
          );
          toast.error(`${file.name}: ${message}`);
        }
      }

      if (fileRef.current) fileRef.current.value = "";
      if (!added.length) return;

      const next = [...datasets, ...added];
      setDatasets(next);

      const names = added.map((dataset) => `"${dataset.name}"`).join(", ");
      void sendMessage(
        {
          text: `I just uploaded ${added.length > 1 ? `${added.length} files` : "a file"}: ${names}. In at most two sentences, say what this data looks like and name one specific question worth asking about it. Do not list the columns or repeat the row counts.`,
        },
        { body: { datasets: next.map((d) => ({ name: d.name, context: d.context })) } },
      );
      focusInput();
    },
    [datasets, focusInput, sendMessage],
  );

  const downloadDataset = useCallback(
    (id: string) => {
      const dataset = datasets.find((item) => item.id === id);
      const rows = rowsRef.current.get(id);
      if (!dataset || !rows?.length) {
        toast.error("That file's rows are no longer in this session.");
        return;
      }
      const name = /\.(csv|tsv|json|xlsx|xls)$/i.test(dataset.name)
        ? dataset.name.replace(/\.(tsv|json|xlsx|xls)$/i, ".csv")
        : `${dataset.name}.csv`;
      const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    },
    [datasets],
  );

  const removeDataset = (id: string) => {
    rowsRef.current.delete(id);
    setDatasets((current) => current.filter((dataset) => dataset.id !== id));
    if (splitTarget === id) setSplitTarget("");
  };

  const mergeableIds = useMemo(
    () => datasets.filter((dataset) => rowsRef.current.has(dataset.id)).map((d) => d.id),
    [datasets],
  );

  /** Non-destructive stack merge: originals stay, a new combined file is added. */
  const mergeFiles = useCallback(() => {
    const parts = datasets.filter((dataset) => rowsRef.current.has(dataset.id));
    if (parts.length < 2) return;
    const rows: Row[] = [];
    for (const part of parts)
      for (const row of rowsRef.current.get(part.id) ?? [])
        rows.push({ source_file: part.name, ...row });

    const dataset = buildDataset(`Merged (${parts.length} files)`, rows, rows.length);
    rowsRef.current.set(dataset.id, rows);
    const stored = toStored(dataset, `Stacked from ${parts.map((part) => part.name).join(" + ")}`);
    setDatasets((current) => [...current, stored]);
    toast.success(`Merged ${rows.length.toLocaleString()} rows into one file.`);
  }, [datasets]);

  const splitFile = useCallback(() => {
    const source = datasets.find((dataset) => dataset.id === splitTarget);
    const rows = source ? rowsRef.current.get(source.id) : undefined;
    if (!source || !rows || !splitColumn) return;

    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row[splitColumn] ?? "(blank)"}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else if (groups.size < MAX_SPLIT_GROUPS) groups.set(key, [row]);
    }
    if (!groups.size) return;

    const created: StoredDataset[] = [];
    for (const [key, groupRows] of groups) {
      const dataset = buildDataset(
        `${source.name} — ${splitColumn}=${key}`,
        groupRows,
        groupRows.length,
      );
      rowsRef.current.set(dataset.id, groupRows);
      created.push(toStored(dataset, `Split from ${source.name} by ${splitColumn}`));
    }
    setDatasets((current) => [...current, ...created]);
    toast.success(
      `Split into ${created.length} file${created.length > 1 ? "s" : ""} by ${splitColumn}.`,
    );
  }, [datasets, splitColumn, splitTarget]);

  const clearThread = () => {
    setMessages([]);
    setThreads((current) => {
      const next = current.filter((thread) => thread.id !== activeId);
      writeThreads(next);
      return next;
    });
    toast.success("Conversation cleared.");
    focusInput();
  };

  const summaries: ThreadSummary[] = useMemo(
    () =>
      threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
        messageCount: thread.messages.length,
      })),
    [threads],
  );

  const cards: DatasetCardInfo[] = [
    ...datasets.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      rowCount: dataset.rowCount,
      columnCount: dataset.columnCount,
      claimType: dataset.claimType,
      hints: dataset.hints,
      ...(dataset.derivedFrom ? { derivedFrom: dataset.derivedFrom } : {}),
      status: "ready" as const,
    })),
    ...pending.map((item) => ({
      id: item.id,
      name: item.name,
      rowCount: 0,
      columnCount: 0,
      status: (item.error ? "failed" : "parsing") as "failed" | "parsing",
      ...(item.error ? { error: item.error } : {}),
    })),
  ];

  const splitColumns =
    datasets.find((dataset) => dataset.id === splitTarget)?.columnNames.slice(0, 60) ?? [];

  const filesContext = useMemo(
    () => ({
      getRows: (name: string) => fileStore.find(name)?.rows ?? null,
      names: datasets.map((dataset) => dataset.name),
    }),
    [datasets, fileStore],
  );

  return (
    <DataFilesContext.Provider value={filesContext}>
      <div
        className="mx-auto flex h-screen w-full max-w-6xl gap-4 px-4 pb-4"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void handleFiles(event.dataTransfer?.files ?? null);
        }}
      >
        <ThreadSidebar
          threads={summaries}
          activeId={activeId}
          onSelect={selectThread}
          onNew={startNewChat}
          onDelete={deleteThread}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="glass-panel mt-3 flex items-center gap-3 rounded-2xl px-4 py-3">
            <img
              src={logo}
              alt="Poly View Health"
              width={36}
              height={36}
              className="h-9 w-9 drop-shadow-[0_0_12px_var(--color-primary)]"
            />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold tracking-tight">
                Poly View Health — Conversational Claims Analyst
              </h1>
              <p className="truncate text-xs text-muted-foreground">
                Preventing fraud, waste &amp; abuse — ask anything, in plain English
              </p>
            </div>

            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".csv,.tsv,.tab,.json,.xlsx,.xls"
              className="hidden"
              onChange={(event) => void handleFiles(event.target.files)}
            />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Paperclip className="mr-2 h-4 w-4" />
              {pending.length ? "Reading…" : "Upload data"}
            </Button>
            {messages.length > 0 ? (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Clear conversation"
                aria-label="Clear conversation"
                onClick={clearThread}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            ) : null}
          </header>

          {dragging ? (
            <p className="mt-2 rounded-xl border border-dashed border-accent/60 px-3 py-2 text-center text-xs text-accent">
              Drop your files to add them to this chat
            </p>
          ) : null}

          {cards.length > 0 ? (
            <section aria-labelledby="datasets-heading" className="flex flex-col gap-2 py-3">
              <h2 id="datasets-heading" className="sr-only">
                Uploaded and generated data files
              </h2>
              <div className="flex flex-wrap gap-2">
                {cards.map((card) => (
                  <DatasetCard
                    key={card.id}
                    info={card}
                    onRemove={removeDataset}
                    onDownload={downloadDataset}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mergeableIds.length < 2}
                  onClick={mergeFiles}
                >
                  <Merge className="mr-2 h-3.5 w-3.5" />
                  Merge files
                </Button>

                <select
                  aria-label="File to split"
                  value={splitTarget}
                  onChange={(event) => {
                    setSplitTarget(event.target.value);
                    setSplitColumn("");
                  }}
                  className="h-8 rounded-md border border-border bg-secondary/40 px-2 text-xs"
                >
                  <option value="">Split which file…</option>
                  {datasets
                    .filter((dataset) => rowsRef.current.has(dataset.id))
                    .map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name}
                      </option>
                    ))}
                </select>

                <select
                  aria-label="Column to split by"
                  value={splitColumn}
                  disabled={!splitColumns.length}
                  onChange={(event) => setSplitColumn(event.target.value)}
                  className="h-8 rounded-md border border-border bg-secondary/40 px-2 text-xs"
                >
                  <option value="">by column…</option>
                  {splitColumns.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </select>

                <Button
                  variant="outline"
                  size="sm"
                  disabled={!splitTarget || !splitColumn}
                  onClick={splitFile}
                >
                  <Scissors className="mr-2 h-3.5 w-3.5" />
                  Split
                </Button>
                <span className="text-[11px]">
                  Originals are kept — merges and splits add new files.
                </span>
              </div>
            </section>
          ) : null}

          <h2 id="conversation-heading" className="sr-only">
            Conversation with the data assistant
          </h2>
          <Conversation aria-labelledby="conversation-heading" className="min-h-0 flex-1">
            <ConversationContent className="gap-6 px-0">
              {messages.length === 0 ? (
                <ConversationEmptyState
                  icon={
                    <img
                      src={logo}
                      alt=""
                      width={56}
                      height={56}
                      className="h-14 w-14"
                      loading="lazy"
                    />
                  }
                  title="Ask about your claims data"
                  description="Drop in one or more CSV, Excel, JSON or TSV files, then ask anything — a number, a chart, a map, a cleanup, an anomaly check, or just help thinking about what to look at."
                />
              ) : null}

              {messages.map((message, index) => {
                const text = messageText(message);
                const reasoning = reasoningText(message);
                const streamingNow =
                  status === "streaming" &&
                  index === messages.length - 1 &&
                  message.role === "assistant";
                return (
                  <Message key={message.id} from={message.role}>
                    <MessageContent>
                      {message.role === "assistant" ? (
                        <>
                          {reasoning && !text ? (
                            <p className="text-xs italic text-muted-foreground">
                              {reasoning.slice(-400)}
                            </p>
                          ) : null}
                          {text ? <AssistantAnswer text={text} /> : null}
                          {streamingNow ? (
                            <span
                              aria-hidden
                              className="inline-block h-4 w-[2px] animate-pulse bg-accent align-middle"
                            />
                          ) : null}
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
            <div className="flex items-center justify-between gap-3 pb-2 text-xs text-destructive">
              <p>{error.message || "The last request failed. Try again."}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void regenerate()}>
                <Loader2 className="mr-2 h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          ) : null}

          <PromptInput
            onSubmit={(_message, event) => {
              event.preventDefault();
              submit(input);
            }}
          >
            <PromptInputTextarea
              aria-label="Ask the Poly View Health data assistant a question"
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                datasets.length
                  ? "Ask anything — “which providers bill far above their peers for the same CPT code?”"
                  : "Ask anything, or drop in a file to analyze"
              }
            />
            <PromptInputFooter className="justify-between">
              <span className="text-[11px] text-muted-foreground">
                {datasets.length
                  ? `Grounded in ${datasets.length} file${datasets.length > 1 ? "s" : ""}`
                  : "No file uploaded yet"}
              </span>
              <span className="flex items-center gap-2">
                {busy ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Stop generating"
                    onClick={() => void stop()}
                  >
                    <Square className="mr-2 h-3.5 w-3.5" />
                    Stop
                  </Button>
                ) : null}
                <PromptInputSubmit status={status} disabled={!input.trim() && !busy} />
              </span>
            </PromptInputFooter>
          </PromptInput>
        </main>
      </div>
    </DataFilesContext.Provider>
  );
}
