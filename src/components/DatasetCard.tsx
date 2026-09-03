import { ChevronDown, Download, FileSpreadsheet, Loader2, TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { RowPreview } from "@/components/RowPreview";
import type { Row } from "@/lib/ops/engine";

export type DatasetCardInfo = {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  claimType?: string;
  hints?: string[];
  derivedFrom?: string;
  generated?: boolean;
  status: "parsing" | "ready" | "failed";
  error?: string;
};

/** Compact metadata card shown per uploaded file instead of a long written summary. */
export function DatasetCard({
  info,
  onRemove,
  onDownload,
  getRows,
}: {
  info: DatasetCardInfo;
  onRemove?: (id: string) => void;
  onDownload?: (id: string) => void;
  getRows?: (id: string) => Row[] | null;
}) {
  const [open, setOpen] = useState(false);
  const previewRows = open && getRows ? getRows(info.id) : null;

  return (
    <div className="glass-panel flex min-w-[15rem] max-w-full flex-1 flex-col gap-2 rounded-xl px-3 py-2.5">
    <div className="flex items-start gap-3">
      <span className="mt-0.5">
        {info.status === "parsing" ? (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        ) : info.status === "failed" ? (
          <TriangleAlert className="h-4 w-4 text-destructive" />
        ) : (
          <FileSpreadsheet className="h-4 w-4 text-accent" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-foreground">{info.name}</p>
        {info.status === "failed" ? (
          <p className="text-[11px] text-destructive">{info.error ?? "Could not be read."}</p>
        ) : info.status === "parsing" ? (
          <p className="text-[11px] text-muted-foreground">Reading…</p>
        ) : (
          <>
            <p className="text-[11px] text-muted-foreground">
              {info.rowCount.toLocaleString()} rows · {info.columnCount} columns
              {info.claimType ? ` · ${info.claimType}` : ""}
            </p>
            {info.derivedFrom ? (
              <p className="truncate text-[11px] text-muted-foreground/80">{info.derivedFrom}</p>
            ) : null}
            {info.hints?.length ? (
              <p className="truncate text-[11px] text-muted-foreground/80">
                {info.hints.slice(0, 2).join(" · ")}
              </p>
            ) : null}
          </>
        )}
      </div>

      {onDownload && info.status === "ready" ? (
        <button
          type="button"
          onClick={() => onDownload(info.id)}
          aria-label={`Download ${info.name} as CSV`}
          title="Download as CSV"
          className="rounded-full p-1 text-accent transition-colors hover:bg-secondary"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      ) : null}

      {getRows && info.status === "ready" ? (
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-label={`${open ? "Hide" : "Show"} preview of ${info.name}`}
          aria-expanded={open}
          title="Preview first rows"
          className="rounded-full p-1 text-accent transition-colors hover:bg-secondary"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      ) : null}

      {onRemove && info.status !== "parsing" ? (
        <button
          type="button"
          onClick={() => onRemove(info.id)}
          aria-label={`Remove ${info.name}`}
          className="rounded-full p-1 transition-colors hover:bg-secondary"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>

      {open ? <RowPreview rows={previewRows ?? []} totalRows={info.rowCount} /> : null}
    </div>
  );
}
