import type { Dataset, Row } from "@/lib/dataset";

type Finding = { kind: string; detail: string; examples: string[] };

const pick = (dataset: Dataset, patterns: RegExp[]): string | undefined =>
  dataset.columns.find((column) => patterns.some((p) => p.test(column.name)))?.name;

const text = (row: Row, key: string | undefined): string =>
  key && row[key] !== null && row[key] !== undefined ? `${row[key]}`.trim() : "";

const num = (row: Row, key: string | undefined): number | undefined => {
  if (!key) return undefined;
  const value = Number(`${row[key] ?? ""}`.replace(/[$,]/g, ""));
  return Number.isFinite(value) ? value : undefined;
};

/** Deterministic billing-anomaly heuristics computed over the rows provided. */
export function detectAnomalies(dataset: Dataset): Finding[] {
  const rows = dataset.rows;
  const providerKey = pick(dataset, [/provider/i, /npi/i, /physician/i, /doctor/i]);
  const patientKey = pick(dataset, [/patient/i, /member/i, /beneficiar/i, /subscriber/i]);
  const dateKey = pick(dataset, [/service.*date/i, /date.*service/i, /^dos$/i, /claim.*date/i, /date/i]);
  const codeKey = pick(dataset, [/procedure/i, /cpt/i, /hcpcs/i, /cdt/i, /^code$/i]);
  const amountKey = pick(dataset, [/paid/i, /amount/i, /charge/i, /billed/i, /allowed/i, /cost/i]);

  const findings: Finding[] = [];

  // 1. Duplicate patient + date + code (possible duplicate billing).
  if (patientKey && dateKey && codeKey) {
    const seen = new Map<string, number>();
    for (const row of rows) {
      const key = `${text(row, patientKey)}|${text(row, dateKey)}|${text(row, codeKey)}`;
      if (key.replace(/\|/g, "").trim()) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, count]) => count > 1);
    if (dupes.length) {
      findings.push({
        kind: "Possible duplicate billing",
        detail: `${dupes.length} patient/date/procedure combinations appear more than once. Innocent explanations include bilateral procedures, legitimate repeat services, and corrected resubmissions.`,
        examples: dupes.slice(0, 5).map(([key, count]) => `${key.replace(/\|/g, " · ")} ×${count}`),
      });
    }
  }

  // 2. Implausible volume per provider per day.
  if (providerKey && dateKey) {
    const perDay = new Map<string, number>();
    for (const row of rows) {
      const key = `${text(row, providerKey)}|${text(row, dateKey)}`;
      if (key.replace(/\|/g, "").trim()) perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    const counts = [...perDay.values()];
    const mean = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
    const heavy = [...perDay.entries()].filter(([, c]) => c >= Math.max(25, mean * 4));
    if (heavy.length) {
      findings.push({
        kind: "High claim volume per provider-day",
        detail: `Some provider-days carry far more claims than the average of ${mean.toFixed(1)}. Group practices billing under one provider ID can look like this legitimately.`,
        examples: heavy
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([key, c]) => `${key.replace(/\|/g, " on ")}: ${c} claims`),
      });
    }
  }

  // 3. Same patient + date billed by multiple providers.
  if (patientKey && dateKey && providerKey) {
    const providersByVisit = new Map<string, Set<string>>();
    for (const row of rows) {
      const key = `${text(row, patientKey)}|${text(row, dateKey)}`;
      if (!key.replace(/\|/g, "").trim()) continue;
      const set = providersByVisit.get(key) ?? new Set<string>();
      set.add(text(row, providerKey));
      providersByVisit.set(key, set);
    }
    const multi = [...providersByVisit.entries()].filter(([, set]) => set.size >= 3);
    if (multi.length) {
      findings.push({
        kind: "Many providers on one patient-day",
        detail: "Three or more distinct providers billed for the same patient on the same date. Common in inpatient stays and referrals, but worth confirming.",
        examples: multi.slice(0, 5).map(([key, set]) => `${key.replace(/\|/g, " on ")}: ${set.size} providers`),
      });
    }
  }

  // 4. Upcoding signal: same code, provider far above peer average amount.
  if (codeKey && amountKey && providerKey) {
    const byCode = new Map<string, { total: number; n: number; byProvider: Map<string, { total: number; n: number }> }>();
    for (const row of rows) {
      const code = text(row, codeKey);
      const amount = num(row, amountKey);
      if (!code || amount === undefined) continue;
      const entry = byCode.get(code) ?? { total: 0, n: 0, byProvider: new Map() };
      entry.total += amount;
      entry.n += 1;
      const provider = text(row, providerKey) || "(unknown)";
      const p = entry.byProvider.get(provider) ?? { total: 0, n: 0 };
      p.total += amount;
      p.n += 1;
      entry.byProvider.set(provider, p);
      byCode.set(code, entry);
    }
    const outliers: string[] = [];
    for (const [code, entry] of byCode) {
      if (entry.n < 8) continue;
      const peerMean = entry.total / entry.n;
      for (const [provider, p] of entry.byProvider) {
        if (p.n < 3) continue;
        const mean = p.total / p.n;
        if (mean > peerMean * 2) {
          outliers.push(
            `${provider} on code ${code}: avg ${mean.toFixed(2)} vs peer avg ${peerMean.toFixed(2)} (${p.n} claims)`,
          );
        }
      }
    }
    if (outliers.length) {
      findings.push({
        kind: "Amount outliers vs peers on the same code",
        detail: "These providers average more than double their peers on an identical procedure code — an upcoding or modifier-usage signal. Case mix, geography, and facility fees can also explain it.",
        examples: outliers.slice(0, 5),
      });
    }
  }

  // 5. Missing key identifiers.
  const sparse = dataset.columns.filter((c) => c.missingPct >= 25);
  if (sparse.length) {
    findings.push({
      kind: "Sparse columns",
      detail: "These columns are missing a quarter or more of their values, which weakens any analysis that depends on them.",
      examples: sparse.slice(0, 6).map((c) => `${c.name}: ${c.missingPct}% missing`),
    });
  }

  return findings;
}

export function describeDetectedColumns(dataset: Dataset): string {
  const map: [string, string | undefined][] = [
    ["provider", pick(dataset, [/provider/i, /npi/i, /physician/i, /doctor/i])],
    ["patient", pick(dataset, [/patient/i, /member/i, /beneficiar/i, /subscriber/i])],
    ["service date", pick(dataset, [/service.*date/i, /date.*service/i, /^dos$/i, /claim.*date/i, /date/i])],
    ["procedure code", pick(dataset, [/procedure/i, /cpt/i, /hcpcs/i, /cdt/i, /^code$/i])],
    ["amount", pick(dataset, [/paid/i, /amount/i, /charge/i, /billed/i, /allowed/i, /cost/i])],
  ];
  return map.map(([role, column]) => `${role}: ${column ?? "not found"}`).join(", ");
}
