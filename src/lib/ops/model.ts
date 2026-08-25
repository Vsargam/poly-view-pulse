/**
 * A real CART decision-tree classifier that runs in the browser over the full
 * rows of a generated file. Gini splits, numeric and categorical features,
 * depth / min-samples controls, deterministic (seeded) train/test split.
 *
 * No argument spreading over row-sized arrays — large files must stay safe.
 */

import { requireColumn, resolveColumn, toNumber, type Row, type Table } from "./engine";

export type FeatureKind = "numeric" | "categorical";

export type Feature = { name: string; kind: FeatureKind; levels?: string[] };

type Node =
  | { leaf: true; classIndex: number; samples: number; distribution: number[] }
  | {
      leaf: false;
      featureIndex: number;
      kind: FeatureKind;
      threshold?: number;
      level?: string;
      samples: number;
      left: Node;
      right: Node;
    };

export type TrainedModel = {
  id: string;
  file: string;
  target: string;
  classes: string[];
  features: Feature[];
  root: Node;
  importances: { feature: string; importance: number }[];
  maxDepth: number;
  minSamplesLeaf: number;
};

export type ConfusionMatrix = {
  classes: string[];
  matrix: number[][];
  positiveClass: string;
  truePositive: number;
  trueNegative: number;
  falsePositive: number;
  falseNegative: number;
  accuracy: number;
  precision: number;
  recall: number;
  fValue: number;
  evaluatedRows: number;
};

const round = (value: number, decimals = 4) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Session-scoped model registry, so a later prompt can predict with the model. */
const registry = new Map<string, TrainedModel>();
let lastModelId: string | null = null;

export const rememberModel = (model: TrainedModel) => {
  registry.set(model.id, model);
  lastModelId = model.id;
  return model;
};

export function getModel(id?: string | null): TrainedModel | null {
  if (id) return registry.get(id) ?? null;
  return lastModelId ? (registry.get(lastModelId) ?? null) : null;
}

/* ------------------------------------------------------------- feature prep */

const MAX_LEVELS = 24;

/** Decide which columns are usable features and whether they are numeric. */
export function inferFeatures(table: Table, ignore: string[], target: string): Feature[] {
  const skip = new Set([target, ...ignore.map((column) => resolveColumn(table.columns, column) ?? column)]);
  const sample = table.rows.slice(0, 2000);
  const features: Feature[] = [];

  for (const column of table.columns) {
    if (skip.has(column)) continue;
    let numeric = 0;
    let present = 0;
    const levels = new Set<string>();
    for (const row of sample) {
      const raw = row?.[column];
      if (raw === null || raw === undefined || `${raw}`.trim() === "") continue;
      present += 1;
      if (toNumber(raw) !== null) numeric += 1;
      if (levels.size <= MAX_LEVELS + 1) levels.add(`${raw}`.trim());
    }
    if (!present) continue;
    if (numeric / present >= 0.9) features.push({ name: column, kind: "numeric" });
    else if (levels.size <= MAX_LEVELS)
      features.push({ name: column, kind: "categorical", levels: [...levels] });
  }
  return features;
}

type Matrix = { x: (number | string | null)[][]; y: number[] };

function encode(table: Table, features: Feature[], target: string, classes: string[]): Matrix {
  const x: (number | string | null)[][] = [];
  const y: number[] = [];
  for (const row of table.rows) {
    const label = `${row?.[target] ?? ""}`.trim();
    const classIndex = classes.indexOf(label);
    if (classIndex < 0) continue;
    const vector: (number | string | null)[] = [];
    for (const feature of features) {
      const raw = row?.[feature.name];
      vector.push(feature.kind === "numeric" ? toNumber(raw) : raw === null || raw === undefined ? null : `${raw}`.trim());
    }
    x.push(vector);
    y.push(classIndex);
  }
  return { x, y };
}

/* ------------------------------------------------------------------- growing */

const gini = (counts: number[], total: number) => {
  if (!total) return 0;
  let sum = 0;
  for (const count of counts) {
    const p = count / total;
    sum += p * p;
  }
  return 1 - sum;
};

const classCounts = (y: number[], indices: number[], classCount: number) => {
  const counts = new Array(classCount).fill(0) as number[];
  for (const index of indices) {
    const cls = y[index] as number;
    counts[cls] = (counts[cls] ?? 0) + 1;
  }
  return counts;
};


const majority = (counts: number[]) => {
  let best = 0;
  for (let i = 1; i < counts.length; i += 1) if ((counts[i] as number) > (counts[best] as number)) best = i;
  return best;
};

function grow(
  data: Matrix,
  features: Feature[],
  indices: number[],
  depth: number,
  maxDepth: number,
  minSamplesLeaf: number,
  classCount: number,
  importances: number[],
  totalRows: number,
): Node {
  const counts = classCounts(data.y, indices, classCount);
  const impurity = gini(counts, indices.length);
  const leaf = (): Node => ({
    leaf: true,
    classIndex: majority(counts),
    samples: indices.length,
    distribution: counts,
  });

  if (depth >= maxDepth || indices.length < minSamplesLeaf * 2 || impurity === 0) return leaf();

  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold: number | undefined;
  let bestLevel: string | undefined;
  let bestLeft: number[] = [];
  let bestRight: number[] = [];

  for (let f = 0; f < features.length; f += 1) {
    const feature = features[f] as Feature;
    if (feature.kind === "numeric") {
      const values: number[] = [];
      for (const index of indices) {
        const value = data.x[index]?.[f];
        if (typeof value === "number") values.push(value);
      }
      if (values.length < minSamplesLeaf * 2) continue;
      values.sort((a, b) => a - b);
      const candidates: number[] = [];
      const steps = Math.min(24, values.length - 1);
      for (let s = 1; s <= steps; s += 1) {
        const position = Math.floor((values.length * s) / (steps + 1));
        const a = values[position - 1] as number;
        const b = values[position] as number;
        if (a !== b) candidates.push((a + b) / 2);
      }
      for (const threshold of candidates) {
        const left: number[] = [];
        const right: number[] = [];
        for (const index of indices) {
          const value = data.x[index]?.[f];
          if (typeof value === "number" && value <= threshold) left.push(index);
          else right.push(index);
        }
        if (left.length < minSamplesLeaf || right.length < minSamplesLeaf) continue;
        const gain =
          impurity -
          (left.length / indices.length) * gini(classCounts(data.y, left, classCount), left.length) -
          (right.length / indices.length) * gini(classCounts(data.y, right, classCount), right.length);
        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = f;
          bestThreshold = threshold;
          bestLevel = undefined;
          bestLeft = left;
          bestRight = right;
        }
      }
    } else {
      for (const level of feature.levels ?? []) {
        const left: number[] = [];
        const right: number[] = [];
        for (const index of indices) {
          if (data.x[index]?.[f] === level) left.push(index);
          else right.push(index);
        }
        if (left.length < minSamplesLeaf || right.length < minSamplesLeaf) continue;
        const gain =
          impurity -
          (left.length / indices.length) * gini(classCounts(data.y, left, classCount), left.length) -
          (right.length / indices.length) * gini(classCounts(data.y, right, classCount), right.length);
        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = f;
          bestThreshold = undefined;
          bestLevel = level;
          bestLeft = left;
          bestRight = right;
        }
      }
    }
  }

  if (bestFeature < 0) return leaf();

  importances[bestFeature] = (importances[bestFeature] ?? 0) + (bestGain * indices.length) / totalRows;

  return {
    leaf: false,
    featureIndex: bestFeature,
    kind: (features[bestFeature] as Feature).kind,
    ...(bestThreshold === undefined ? {} : { threshold: bestThreshold }),
    ...(bestLevel === undefined ? {} : { level: bestLevel }),
    samples: indices.length,
    left: grow(data, features, bestLeft, depth + 1, maxDepth, minSamplesLeaf, classCount, importances, totalRows),
    right: grow(data, features, bestRight, depth + 1, maxDepth, minSamplesLeaf, classCount, importances, totalRows),
  };
}

function walk(node: Node, vector: (number | string | null)[]): number {
  let current = node;
  while (!current.leaf) {
    const value = vector[current.featureIndex] ?? null;
    const goLeft =
      current.kind === "numeric"
        ? typeof value === "number" && value <= (current.threshold as number)
        : value === current.level;
    current = goLeft ? current.left : current.right;
  }
  return current.classIndex;
}

/* -------------------------------------------------------------- public API */

export type TrainOptions = {
  file: string;
  target: string;
  ignore_columns?: string[];
  max_depth?: number;
  min_samples_leaf?: number;
  /** Fraction held out for evaluation; 0 evaluates on the training rows. */
  test_size?: number;
  positive_class?: string;
};

export function trainDecisionTree(
  table: Table,
  options: TrainOptions,
): { model: TrainedModel; evaluation: ConfusionMatrix; treeText: string } {
  const target = requireColumn(table.columns, options.target, "target column");
  const labels = new Map<string, number>();
  for (const row of table.rows) {
    const label = `${row?.[target] ?? ""}`.trim();
    if (label) labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  if (labels.size < 2)
    throw new Error(
      `Column "${target}" has ${labels.size} usable label value(s); a classifier needs at least two. Check that the labels were joined onto this file.`,
    );
  if (labels.size > 10)
    throw new Error(`Column "${target}" has ${labels.size} distinct values — that looks like an ID, not a class label.`);

  const classes = [...labels.keys()].sort();
  const features = inferFeatures(table, options.ignore_columns ?? [], target);
  if (!features.length) throw new Error("No usable feature columns were found once the ignored columns were removed.");

  const data = encode(table, features, target, classes);
  if (data.y.length < 20) throw new Error("Not enough labelled rows to train a model (need at least 20).");

  // Deterministic shuffle so results are reproducible across turns.
  const order = data.y.map((_, index) => index);
  let seed = 42;
  for (let i = order.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    const tmp = order[i] as number;
    order[i] = order[j] as number;
    order[j] = tmp;
  }
  const testSize = Math.min(Math.max(options.test_size ?? 0.2, 0), 0.5);
  const testCount = Math.floor(order.length * testSize);
  const testIndices = order.slice(0, testCount);
  const trainIndices = testCount ? order.slice(testCount) : order;

  const maxDepth = Math.min(Math.max(options.max_depth ?? 6, 1), 20);
  const minSamplesLeaf = Math.max(options.min_samples_leaf ?? 5, 1);
  const importances = new Array(features.length).fill(0) as number[];
  const root = grow(
    data,
    features,
    trainIndices,
    0,
    maxDepth,
    minSamplesLeaf,
    classes.length,
    importances,
    trainIndices.length || 1,
  );

  const importanceTotal = importances.reduce((total, value) => total + value, 0) || 1;
  const model: TrainedModel = {
    id: `tree-${Date.now()}`,
    file: options.file,
    target,
    classes,
    features,
    root,
    importances: features
      .map((feature, index) => ({
        feature: feature.name,
        importance: round((importances[index] ?? 0) / importanceTotal),
      }))
      .sort((a, b) => b.importance - a.importance),
    maxDepth,
    minSamplesLeaf,
  };
  rememberModel(model);

  const evalIndices = testIndices.length ? testIndices : trainIndices;
  const matrix = classes.map(() => classes.map(() => 0));
  for (const index of evalIndices) {
    const actual = data.y[index] as number;
    const predicted = walk(root, data.x[index] as (number | string | null)[]);
    (matrix[actual] as number[])[predicted] = ((matrix[actual] as number[])[predicted] as number) + 1;
  }

  const evaluation = summarizeMatrix(classes, matrix, options.positive_class);
  return { model, evaluation, treeText: describeTree(model) };
}

export function summarizeMatrix(
  classes: string[],
  matrix: number[][],
  positiveClass?: string,
): ConfusionMatrix {
  const preferred =
    (positiveClass && classes.find((label) => label.toLowerCase() === positiveClass.toLowerCase())) ??
    classes.find((label) => /^(yes|y|1|true|fraud)$/i.test(label)) ??
    classes[classes.length - 1] ??
    "";
  const positive = classes.indexOf(preferred);

  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let total = 0;
  for (let actual = 0; actual < classes.length; actual += 1)
    for (let predicted = 0; predicted < classes.length; predicted += 1) {
      const count = (matrix[actual] as number[])[predicted] ?? 0;
      total += count;
      if (actual === positive && predicted === positive) truePositive += count;
      else if (actual === positive) falseNegative += count;
      else if (predicted === positive) falsePositive += count;
      else trueNegative += count;
    }

  const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0;
  const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 0;
  return {
    classes,
    matrix,
    positiveClass: preferred,
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    accuracy: total ? round((truePositive + trueNegative) / total) : 0,
    precision: round(precision),
    recall: round(recall),
    fValue: precision + recall ? round((2 * precision * recall) / (precision + recall)) : 0,
    evaluatedRows: total,
  };
}

export function describeTree(model: TrainedModel, maxLines = 40): string {
  const lines: string[] = [];
  const render = (node: Node, prefix: string) => {
    if (lines.length >= maxLines) return;
    if (node.leaf) {
      lines.push(`${prefix}predict ${model.classes[node.classIndex]} (${node.samples} rows)`);
      return;
    }
    const feature = model.features[node.featureIndex]?.name ?? "?";
    const test =
      node.kind === "numeric" ? `${feature} <= ${round(node.threshold ?? 0, 3)}` : `${feature} == "${node.level}"`;
    lines.push(`${prefix}if ${test}`);
    render(node.left, `${prefix}  `);
    lines.push(`${prefix}else`);
    render(node.right, `${prefix}  `);
  };
  render(model.root, "");
  return lines.join("\n");
}

/** Apply a trained model to another table. */
export function predictWith(
  model: TrainedModel,
  table: Table,
  options: { id_column?: string; output_column?: string } = {},
): Table & { counts: { label: string; count: number }[] } {
  const idColumn = options.id_column ? requireColumn(table.columns, options.id_column, "column") : null;
  const outputColumn = options.output_column?.trim() || "prediction";
  const columns = idColumn ? [idColumn, outputColumn] : [...table.columns, outputColumn];
  const tally = new Map<string, number>();

  const rows: Row[] = table.rows.map((row) => {
    const vector = model.features.map((feature) => {
      const raw = row?.[feature.name];
      return feature.kind === "numeric"
        ? toNumber(raw)
        : raw === null || raw === undefined
          ? null
          : `${raw}`.trim();
    });
    const label = model.classes[walk(model.root, vector)] ?? "";
    tally.set(label, (tally.get(label) ?? 0) + 1);
    if (idColumn) return { [idColumn]: row?.[idColumn] ?? null, [outputColumn]: label };
    const next: Row = {};
    for (const column of table.columns) next[column] = row?.[column] ?? null;
    next[outputColumn] = label;
    return next;
  });

  return {
    columns,
    rows,
    counts: [...tally.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
  };
}
