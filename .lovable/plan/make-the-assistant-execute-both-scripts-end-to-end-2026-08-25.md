# Make the assistant execute both scripts end to end

The first document (data prep, histograms, paired charts, state recoding, choropleth, provider link analysis) is already covered by the existing analysis engine. The second document (the Julius session) needs new capabilities: stacking files with a source flag, provider-level aggregation joined to labels, a decision tree with a labelled confusion matrix and precision/recall/F-value, prediction files, and Local Outlier Factor scoring. Those get built as real, deterministic operations that run in the browser over the full rows, plus a rewritten assistant prompt that knows the whole catalogue.

## New capabilities

### 1. Combining files
- **stack_files** — append two or more files row-wise (pandas `concat` equivalent), optionally adding a source-marker column with a value per input file (`Source` = 1 for inpatient, 0 for outpatient). Missing columns fill blank. Output: `Merged_Train_Inpatient_Outpatient.csv`.
- **join_files** — left/inner join a file to a second file on a key column, bringing in selected columns (attach `PotentialFraud` from `Train_labels.csv` onto provider-level rows).

### 2. Richer aggregation
Extend the aggregate operation with the metric forms the provider-level dataset needs:
- `count / distinct_column` ratios — average claims per `ClaimEndDt`, average distinct patients per `ClaimEndDt`.
- `distinct_count` of one column divided by `distinct_count` of another.
- custom output names (`Total_Claims`, `Avg_Claims_Per_Day`, `Avg_InscClaimAmtReimbursed`, `Avg_DeductibleAmtPaid`, `Avg_Patients_Per_Day`).

### 3. Modelling (real models, client-side)
- **train_decision_tree** — CART classifier on a file: choose target column, ignore listed columns (e.g. `Provider`), Gini splits, max-depth / min-samples controls, optional train/test split. Returns the confusion matrix **with explicit TN / FP / FN / TP labels**, accuracy, precision, recall, F-value, feature importances, and a readable tree summary. The trained model is kept in the session so a later prompt can predict with it.
- **predict** — apply the session's trained model to another file and write `Test_predictions.csv` (`Provider`, `prediction`).
- **lof_outliers** — Local Outlier Factor over selected continuous columns (k-neighbours, standardised distances). Writes a predictions file with the entity column, the label, and the LOF score. Label encoding is configurable so "1 = outlier, 0 = inlier" is a single follow-up prompt.
- **recode_values** — map values in a column to new values (`-1 -> 1`, `1 -> 0`) and save the updated file, so the relabelling turn works without special-casing.

### 4. Model output rendering
- A confusion-matrix block rendered as a labelled 2x2 grid with TN/FP/FN/TP annotations and the metric row beneath it.
- A feature-importance horizontal bar chart, reusing the existing chart block.

## Assistant prompt rewrite

The system prompt gets a full, ordered operation catalogue and an explicit workflow policy:
- Always compute with operations; never estimate from the sample rows.
- Chain operations: every generated file is a valid input to the next step, and outputs use the exact names the user asks for.
- Honour "Don't do anything else!" — perform exactly the requested step, report the created file, and stop.
- Preserve column positions when the request says so; never append a column at the end when a position was specified.
- Explain model results in plain language: what each confusion-matrix cell means for fraud detection, what precision/recall/F-value imply, what an LOF label of 1 means.
- Handle near-miss phrasings of both scripts, and answer free-form questions conversationally.
- Never suggest running anything locally; every file appears in the thread with a download button.

## Technical notes

- New modules: `src/lib/ops/combine.ts` (stack/join), `src/lib/ops/model.ts` (CART + metrics), `src/lib/ops/lof.ts`, with tool schemas added to `src/lib/ops/tools.ts` and dispatch in `src/lib/ops/execute.ts`.
- Trained models live in a browser-session ref alongside the existing full-row file store; `predict` errors clearly if no model has been trained in the conversation.
- All numeric work uses typed arrays and loops — no argument spreading — so 500k-row outpatient files stay safe.
- New components: `ConfusionMatrixBlock`, wired into `AssistantAnswer` as a `matrix` fenced block.
- Large files: modelling ops operate on aggregated provider-level data (~5k rows), so tree training and LOF stay fast; row caps with a stated limit protect against accidental use on raw claim files.

## Verification

Run both scripts end to end in the browser against sample files: the augmented file with correctly positioned columns, `diagcode_hist.csv` / `proccode_hist.csv` and their paired horizontal histograms, the fraud-label bar chart with values, state filtering + recoding + blue choropleth, provider pair counts and the interactive network graph, then the merged file with `Source`, the provider-level dataset joined to labels, the decision tree confusion matrix and metrics, `Test_predictions.csv`, and LOF predictions with scores and re-encoded labels.
