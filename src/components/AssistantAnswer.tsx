import { MessageResponse } from "@/components/ai-elements/message";
import { ChartBlock, type ChartSpec } from "@/components/ChartBlock";

type Segment = { kind: "text"; value: string } | { kind: "chart"; spec: ChartSpec };

/** Splits assistant markdown into prose segments and inline ```chart JSON blocks. */
function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /```chart\s*([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ kind: "text", value: before });
    try {
      segments.push({ kind: "chart", spec: JSON.parse((match[1] ?? "").trim()) as ChartSpec });
    } catch {
      segments.push({ kind: "text", value: match[0] });
    }
    lastIndex = pattern.lastIndex;
  }

  const rest = text.slice(lastIndex);
  if (rest.trim() || !segments.length) segments.push({ kind: "text", value: rest });
  return segments;
}

export function AssistantAnswer({ text }: { text: string }) {
  return (
    <div className="prose-chat flex w-full min-w-0 flex-col">
      {splitSegments(text).map((segment, index) =>
        segment.kind === "chart" ? (
          <ChartBlock key={index} spec={segment.spec} />
        ) : (
          <MessageResponse key={index}>{segment.value}</MessageResponse>
        ),
      )}
    </div>
  );
}
