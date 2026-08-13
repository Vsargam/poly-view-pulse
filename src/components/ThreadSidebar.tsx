import { MessageSquare, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

export type ThreadSummary = {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
};

const relative = (timestamp: number) => {
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
};

export function ThreadSidebar({
  threads,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  threads: ThreadSummary[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-3 py-3 md:flex">
      <div className="flex min-h-0 flex-1 flex-col rounded-2xl glass-panel p-3">
        <Button variant="outline" size="sm" className="w-full justify-start" onClick={onNew}>
          <Plus className="mr-2 h-4 w-4" />
          New chat
        </Button>

        <p className="px-1 pt-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Previous chats
        </p>

        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label="Previous conversations">
          {threads.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              Nothing yet — your past conversations will appear here.
            </p>
          ) : null}

          {threads.map((thread) => {
            const active = thread.id === activeId;
            return (
              <div
                key={thread.id}
                className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                  active ? "bg-secondary text-foreground" : "hover:bg-secondary/60"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(thread.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-current={active ? "true" : undefined}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{thread.title}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {relative(thread.updatedAt)} · {thread.messageCount} messages
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(thread.id)}
                  aria-label={`Delete ${thread.title}`}
                  className="rounded p-1 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
