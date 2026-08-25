import { tool } from "ai";
import { z } from "zod";

/**
 * Tool definitions shared by the chat route (declaration only, no server
 * `execute`) and the browser (which runs them against the full uploaded rows).
 */

const fileField = z
  .string()
  .describe("Name of the file to read, exactly as shown in the file list.");

const outputField = z
  .string()
  .optional()
  .describe("Name for the new file this creates, e.g. diagcode_hist.csv.");

const derivedColumn = z.object({
  name: z.string().describe('Name of the new column, e.g. "#days".'),
  after: z.string().optional().describe("Insert directly AFTER this existing column."),
  before: z.string().optional().describe("Insert directly BEFORE this existing column."),
  kind: z.enum(["date_diff_days", "value_frequency_share", "arithmetic", "constant"]),
  start_column: z.string().optional().describe("date_diff_days: the earlier date column."),
  end_column: z.string().optional().describe("date_diff_days: the later date column."),
  column: z
    .string()
    .optional()
    .describe("value_frequency_share: count of this row's value in the whole column / total rows."),
  left_column: z.string().optional(),
  right_column: z.string().optional(),
  left_value: z.number().optional(),
  right_value: z.number().optional(),
  operator: z.enum(["+", "-", "*", "/"]).optional(),
  value: z.union([z.string(), z.number()]).optional().describe("constant: the fixed value."),
  decimals: z.number().optional(),
});

const metric = z.object({
  op: z.enum([
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "distinct_count",
    "count_per_distinct",
    "distinct_per_distinct",
  ]),
  column: z.string().optional().describe("Column to aggregate (not needed for count)."),
  per_column: z
    .string()
    .optional()
    .describe(
      "Denominator column for ratio ops: count_per_distinct = rows / distinct values of per_column (e.g. average claims per ClaimEndDt); distinct_per_distinct = distinct values of column / distinct values of per_column (e.g. average distinct patients per ClaimEndDt).",
    ),
  as: z.string().optional().describe('Output column name, e.g. "# occurrences".'),
});


export const opTools = {
  add_columns: tool({
    description:
      "Create derived columns in a file and save the result as a NEW file, inserting each new column at an exact position (after/before a named column). Use for day-differences between dates, frequency shares of a value within its column, and arithmetic between columns.",
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      columns: z.array(derivedColumn).min(1),
    }),
  }),

  aggregate: tool({
    description:
      "Group a file by one or more columns and compute count / sum / avg / min / max / distinct_count over the FULL file, saving the result as a new file. Use this for histogram tables such as diagcode_hist.csv or state_hist.csv.",
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      group_by: z.array(z.string()).min(1),
      metrics: z.array(metric).min(1),
      sort_by: z.string().optional(),
      direction: z.enum(["asc", "desc"]).optional(),
      limit: z.number().optional().describe("Keep only the top N rows after sorting."),
    }),
  }),

  distinct_values: tool({
    description:
      "Count distinct values of a column across the full file, with the most frequent values.",
    inputSchema: z.object({ file: fileField, column: z.string() }),
  }),

  filter_rows: tool({
    description:
      "Keep or drop rows by a column condition and save the result as a new file (e.g. remove State values 52, 53, 54).",
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      column: z.string(),
      op: z.enum([
        "in",
        "not_in",
        "equals",
        "not_equals",
        "gt",
        "gte",
        "lt",
        "lte",
        "contains",
        "is_null",
        "not_null",
      ]),
      values: z.array(z.union([z.string(), z.number()])).optional(),
    }),
  }),

  lookup_replace: tool({
    description:
      "Recode a column in place using a mapping from a second uploaded file (e.g. replace State numbers with state names). The column keeps its original position.",
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      column: z.string().describe("Column in `file` whose values get replaced."),
      lookup_file: z.string().describe("File holding the mapping."),
      key_column: z.string().describe("Column in the lookup file matching the current values."),
      value_column: z.string().describe("Column in the lookup file holding the replacement values."),
      unmatched: z.enum(["keep", "blank", "drop_row"]).optional(),
    }),
  }),

  top_n: tool({
    description:
      "Sort a file by a column and return the top N rows (also saved as a new file so it can be charted).",
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      column: z.string(),
      direction: z.enum(["asc", "desc"]).optional(),
      limit: z.number().optional(),
    }),
  }),

  fill_missing: tool({
    description:
      "Fix missing values in a file before plotting, either by filling them with a value or dropping the affected rows. Saves a new file.",
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      columns: z.array(z.string()).optional(),
      value: z.union([z.string(), z.number()]).optional(),
      drop_rows: z.boolean().optional(),
    }),
  }),

  pair_overlap: tool({
    description:
      "Link analysis: for an entity column (e.g. Provider) and a member column (e.g. BENEID), compute how many members each pair of entities shares. Optionally sum a measure across those shared members, restrict to pairs above a threshold, or ask about one specific pair. Saves a pairs file.",
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      entity_column: z.string(),
      member_column: z.string(),
      measure_column: z.string().optional(),
      min_shared: z.number().optional().describe("Only keep pairs with at least this many shared members."),
      entity_a: z.string().optional(),
      entity_b: z.string().optional(),
      limit: z.number().optional(),
    }),
  }),

  preview_file: tool({
    description: "Read the first rows and the column list of a file (uploaded or generated).",
    inputSchema: z.object({ file: fileField, limit: z.number().optional() }),
  }),

  stack_files: tool({
    description:
      "Append two or more files row-wise into one new file (the pandas concat equivalent), optionally adding a source-marker column that records which file each row came from. Use for merging inpatient + outpatient claims with Source = 1 / 0.",
    inputSchema: z.object({
      output_file: outputField,
      source_column: z
        .string()
        .optional()
        .describe('Name of the marker column to add, e.g. "Source". Omit for a plain append.'),
      inputs: z
        .array(
          z.object({
            file: fileField,
            marker: z
              .union([z.string(), z.number()])
              .optional()
              .describe("Value written into source_column for rows from this file, e.g. 1 or 0."),
          }),
        )
        .min(2),
    }),
  }),

  join_files: tool({
    description:
      "Left- or inner-join a file to a second file on a shared key column, bringing in selected columns (e.g. attach PotentialFraud from Train_labels.csv onto a provider-level file). Saves a new file.",
    inputSchema: z.object({
      file: fileField,
      right_file: z.string().describe("The file whose columns get attached."),
      output_file: outputField,
      key: z.string().describe("Key column in `file`."),
      right_key: z.string().optional().describe("Key column in `right_file` when the name differs."),
      columns: z.array(z.string()).optional().describe("Columns to bring in; defaults to all non-key columns."),
      how: z.enum(["left", "inner"]).optional(),
    }),
  }),

  recode_values: tool({
    description:
      'Replace specific values in one column with new values, keeping the column position, and save a new file (e.g. change LOF predictions from -1/1 to 1/0).',
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      column: z.string(),
      mapping: z
        .array(z.object({ from: z.union([z.string(), z.number()]), to: z.union([z.string(), z.number()]) }))
        .min(1),
      unmatched: z.enum(["keep", "blank"]).optional(),
    }),
  }),

  train_decision_tree: tool({
    description:
      "Train a real CART decision-tree classifier in the browser on a file, ignoring the columns you list (e.g. Provider). Returns a labelled confusion matrix (TN/FP/FN/TP), accuracy, precision, recall, F-value, feature importances, and the tree rules. The trained model stays available in this conversation for the predict tool.",
    inputSchema: z.object({
      file: fileField,
      target: z.string().describe('Label column, e.g. "PotentialFraud".'),
      ignore_columns: z.array(z.string()).optional().describe('Columns excluded from the features, e.g. ["Provider"].'),
      max_depth: z.number().optional(),
      min_samples_leaf: z.number().optional(),
      test_size: z
        .number()
        .optional()
        .describe("Hold-out fraction for evaluation (default 0.2). Use 0 to evaluate on the training rows."),
      positive_class: z.string().optional().describe('Which label counts as positive, e.g. "Yes".'),
    }),
  }),

  predict: tool({
    description:
      "Apply the decision tree trained earlier in this conversation to another file and save a predictions file (e.g. Provider + prediction).",
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      id_column: z.string().optional().describe('Identifier to keep alongside the prediction, e.g. "Provider".'),
      output_column: z.string().optional().describe('Name of the prediction column, default "prediction".'),
    }),
  }),

  lof_outliers: tool({
    description:
      "Run a Local Outlier Factor outlier-detection model over continuous columns of a file and save a predictions file with the identifier, the label, and the LOF score. Default labels are -1 for outliers and 1 for inliers; override them when the user asks for 1/0.",
    inputSchema: z.object({
      file: fileField,
      output_file: outputField,
      columns: z.array(z.string()).optional().describe("Continuous columns to use; defaults to the first 5 found."),
      id_column: z.string().optional().describe('Identifier column to keep, e.g. "Provider".'),
      k: z.number().optional().describe("Number of neighbours (default 20)."),
      contamination: z.number().optional().describe("Expected outlier fraction (default 0.05)."),
      outlier_label: z.union([z.string(), z.number()]).optional(),
      inlier_label: z.union([z.string(), z.number()]).optional(),
      prediction_column: z.string().optional(),
      score_column: z.string().optional().describe('Name of the LOF score column, default "LOF_score".'),
    }),
  }),
};


export type OpToolName = keyof typeof opTools;
