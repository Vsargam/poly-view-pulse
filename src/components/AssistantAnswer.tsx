import { MessageResponse } from "@/components/ai-elements/message";
import { ChartBlock, type ChartSpec } from "@/components/ChartBlock";
import { ChartGrid, type ChartGridSpec } from "@/components/ChartGrid";
import { ConfusionMatrixBlock, type MatrixSpec } from "@/components/ConfusionMatrixBlock";
import { MapBlock, type MapSpec } from "@/components/MapBlock";
import { NetworkBlock, type NetworkSpec } from "@/components/NetworkBlock";

type Segment =
  | { kind: "text"; value: string }
  | { kind: "chart"; spec: ChartSpec }
  | { kind: "charts"; spec: ChartGridSpec }
  | { kind: "map"; spec: MapSpec }
  | { kind: "network"; spec: NetworkSpec }
  | { kind: "matrix"; spec: MatrixSpec };

/** Splits assistant markdown into prose and inline ```chart / ```charts / ```map / ```network / ```matrix JSON blocks. */
function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /```(charts|chart|map|network|matrix)\s*([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ kind: "text", value: before });
    try {
      const spec = JSON.parse((match[2] ?? "").trim()) as never;
      const kind = match[1];
      if (kind === "map") segments.push({ kind: "map", spec: spec as MapSpec });
      else if (kind === "network") segments.push({ kind: "network", spec: spec as NetworkSpec });
      else if (kind === "matrix") segments.push({ kind: "matrix", spec: spec as MatrixSpec });
      else if (kind === "charts") segments.push({ kind: "charts", spec: spec as ChartGridSpec });
      else segments.push({ kind: "chart", spec: spec as ChartSpec });
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
        ) : segment.kind === "charts" ? (
          <ChartGrid key={index} spec={segment.spec} />
        ) : segment.kind === "map" ? (
          <MapBlock key={index} spec={segment.spec} />
        ) : segment.kind === "network" ? (
          <NetworkBlock key={index} spec={segment.spec} />
        ) : segment.kind === "matrix" ? (
          <ConfusionMatrixBlock key={index} spec={segment.spec} />
        ) : (
          <MessageResponse key={index}>{segment.value}</MessageResponse>
        ),
      )}
    </div>
  );
}
