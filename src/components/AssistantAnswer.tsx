import { MessageResponse } from "@/components/ai-elements/message";
import { ChartBlock, type ChartSpec } from "@/components/ChartBlock";
import { MapBlock, type MapSpec } from "@/components/MapBlock";

type Segment =
  | { kind: "text"; value: string }
  | { kind: "chart"; spec: ChartSpec }
  | { kind: "map"; spec: MapSpec };

/** Splits assistant markdown into prose and inline ```chart / ```map JSON blocks. */
function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /```(chart|map)\s*([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ kind: "text", value: before });
    try {
      const spec = JSON.parse((match[2] ?? "").trim()) as ChartSpec & MapSpec;
      segments.push(
        match[1] === "map" ? { kind: "map", spec } : { kind: "chart", spec: spec as ChartSpec },
      );
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
        ) : segment.kind === "map" ? (
          <MapBlock key={index} spec={segment.spec} />
        ) : (
          <MessageResponse key={index}>{segment.value}</MessageResponse>
        ),
      )}
    </div>
  );
}
