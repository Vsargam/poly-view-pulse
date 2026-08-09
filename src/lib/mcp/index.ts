import { defineMcp, type AnyToolDefinition } from "@lovable.dev/mcp-js";
import profileDataset from "./tools/profile-dataset";
import detectBillingAnomalies from "./tools/detect-billing-anomalies";
import askAnalyst from "./tools/ask-analyst";

export default defineMcp({
  name: "poly-view-pulse",
  title: "PolyView Insight",
  version: "0.1.0",
  instructions:
    "Healthcare claims analysis tools from PolyView Insight. Send a claims dataset inline as CSV, TSV, or JSON text. Use `profile_dataset` to understand a file's structure and clinical coding systems, `detect_billing_anomalies` for deterministic duplicate/volume/upcoding checks, and `ask_analyst` for a reasoned natural-language answer to any question about the data.",
  tools: [profileDataset, detectBillingAnomalies, askAnalyst] as AnyToolDefinition[],

});
