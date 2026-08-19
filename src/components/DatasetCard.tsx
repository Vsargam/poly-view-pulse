import { FileSpreadsheet, Loader2, TriangleAlert, X } from "lucide-react";

export type DatasetCardInfo = {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  claimType?: string;
  hints?: string[];
  derivedFrom?: string;
  status: "parsing" | "ready" | "failed";
  error?: string;
};

/** Compact metadata card shown per uploaded file instead of a long written summary. */
export function DatasetCard({
  info,
  onRemove,
}: {
  info: DatasetCardInfo;
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="glass-panel flex min-w-[15rem] max-w-full flex-1 items-start gap-3 rounded-xl px-3 py-2.5">
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
  );
}
