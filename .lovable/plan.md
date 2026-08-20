# Make the assistant actually execute the scripted prompts

Your document is a set of real analyst tasks: create derived columns at exact positions, build new aggregate files, download CSVs, draw paired horizontal histograms, recode states via a lookup file, shade a US map by count, and do provider link analysis with an interactive network graph.

Right now the assistant only *sees a sample* of each uploaded file in its prompt, so it can describe data but cannot compute over the full file, cannot create new files, and has no chart types for paired histograms or network graphs. That is why script-style prompts fall short.

## What changes

### 1. A real compute engine the AI can call
Add a deterministic, in-browser analysis engine that runs over the *full* rows of every uploaded file (rows already live in the page). The AI gets a set of callable operations and picks which to run, with which columns, based on plain English — so both the scripted prompts and free-form variations work.

Operations:
- **add_columns** — derived columns inserted at a named position (after/before an existing column): date difference in days, frequency share of a value in its column, arithmetic between columns, constants. Produces a new file (e.g. `Train_Inpatientdata_augmented.csv`), originals untouched.
- **aggregate** — group by one or more columns with count / sum / avg / min / max / distinct-count, with custom output column names (`# occurrences`, `Avg_Inns_ClaimAmt`) → new file such as `diagcode_hist.csv`, `proccode_hist.csv`, `state_hist.csv`.
- **distinct_count** / **profile column** — "how many distinct values for ClmAdmitDiagnosisCode".
- **filter** — drop or keep rows by value list, range, or null-ness (e.g. remove State 52/53/54).
- **lookup_replace** — recode a column in place using a mapping from a second uploaded file (State number → state name), keeping the column's original position.
- **sort / top_n** — top 20 by any measure.
- **pair_overlap** — link analysis: for an entity column (Provider) and a member column (BENEID), count shared members for a specific pair, or emit all pairs with ≥1 shared member plus an optional summed measure (Total_InscClaimAmtReimbursed). Emits a downloadable pairs CSV.
- **fill_missing** — fix nulls before plotting, as the map prompt requires.

Every op that produces data registers a **new file** in the conversation with a download button, so `..._augmented.csv`, `diagcode_hist.csv`, `state_hist.csv`, and the provider-pairs CSV are all real downloadable outputs. Derived files are usable as inputs to later prompts, so chained scripts work.

### 2. New visual types
- **Paired charts**: two charts side by side with independent axes, each independently sorted.
- **Horizontal bar histograms** with categorical axis labels and optional value labels on bars (the PotentialFraud chart).
- **Choropleth**: already supported; it will now be fed by a computed `state_hist` file with nulls handled, and shaded in graduated blues.
- **Network graph**: providers as nodes, edges only above a threshold (e.g. >12 shared patients), edge thickness proportional to shared patients, force-directed spacing, and hover-on-edge tooltip showing shared-patient count and the summed reimbursement.

### 3. Prompt and behaviour updates
- Teach the assistant the full operation catalogue and the new chart/graph block formats, and instruct it to *compute with operations* rather than eyeballing the sample whenever a prompt asks for counts, new columns, new files, or top-N.
- Multi-file awareness: operations always name their input file, so "regardless of how many files" holds; when a prompt is ambiguous about which file, the assistant states its assumption or asks one short question.
- Free-form prompts still get the normal conversational answer — the engine is additive, not a rigid command parser. A near-miss phrasing of a scripted prompt maps to the same operations.
- Never tell the user to run anything locally; results and files appear in the thread.

## Technical notes

- Client-side tool calling with the existing `useChat` setup: tools declared on `/api/chat` without a server `execute`, executed in `src/routes/index.tsx` against the full-row store (`rowsRef`), results returned to the model, which then narrates and renders.
- New modules: `src/lib/ops/*` (column derivation, aggregation, filter/lookup, pair overlap, CSV serialisation) with the tool schemas in a client-safe module.
- New components: `ChartGrid` (paired charts), horizontal-bar + value-label support in `ChartBlock`, `NetworkBlock` (d3-force layout in SVG with edge tooltips), download control on dataset cards.
- Ops run on typed arrays/maps with no argument spreading, so large files stay safe (same class of bug as the earlier stack-overflow fix).
- Very large pair-overlap results are capped with a stated cap, and the CSV still contains the full computed set.

## Verification

Run the scripted prompts end to end in the browser against sample inpatient / beneficiary / labels / state-mapping files: augmented file with correctly positioned columns, `diagcode_hist.csv` values matching a hand-checked example, paired top-20 horizontal histograms, PotentialFraud bars with labels, state recoding plus blue choropleth, provider pair counts, and the interactive network graph.
