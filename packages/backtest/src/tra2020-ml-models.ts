/**
 * TRA-2024 (impl of TRA-2022) — the two FROZEN model families for the ML spike
 * (pre-reg §4): an L2-regularized multinomial logistic regression and a shallow
 * gradient-boosted-tree classifier. **No LSTM, no RL, no deep nets** (hard out-
 * of-scope per parent [TRA-2020]).
 *
 * Deliberately dependency-light and PURE-DETERMINISTIC: no `Math.random`, no
 * subsampling, zero-initialized weights, fixed iteration counts. Given the same
 * (X, y) the fit is bit-reproducible — the smoke report is stable across runs and
 * the overfitting statistics (PBO / deflated Sharpe) mean what they say.
 *
 * The standardizer is fit on TRAIN statistics ONLY and applied unchanged to
 * test/holdout (pre-reg §3 — scaling that peeks at the holdout is leakage).
 */

export const CLASS_COUNT = 3;

// ── numerics ──────────────────────────────────────────────────────────────────

/** Numerically-stable softmax over one logit vector (subtract the max). */
export function softmax(logits: readonly number[]): number[] {
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  let sum = 0;
  const exps = logits.map((v) => {
    const e = Math.exp(v - max);
    sum += e;
    return e;
  });
  return sum > 0 ? exps.map((e) => e / sum) : logits.map(() => 1 / logits.length);
}

/** Argmax with a deterministic tie-break (first index wins). */
export function argmax(xs: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

/** Shared classifier surface so the harness treats logreg / GBM uniformly. */
export interface Classifier {
  predictProba(x: readonly number[]): number[];
  predictClass(x: readonly number[]): number;
}

// ── feature standardizer (fit on TRAIN only) ─────────────────────────────────

export class Standardizer {
  readonly mean: number[];
  readonly std: number[];

  private constructor(mean: number[], std: number[]) {
    this.mean = mean;
    this.std = std;
  }

  /** Fit per-column mean/std on the training matrix ONLY (pre-reg §3). */
  static fit(X: readonly number[][]): Standardizer {
    const d = X.length > 0 ? X[0].length : 0;
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(1);
    if (X.length === 0) return new Standardizer(mean, std);
    for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
    for (let j = 0; j < d; j++) mean[j] /= X.length;
    for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
    for (let j = 0; j < d; j++) {
      std[j] = Math.sqrt(std[j] / X.length);
      // A zero-variance column would divide by zero; leave it at 1 (→ centered 0).
      if (!(std[j] > 1e-12)) std[j] = 1;
    }
    return new Standardizer(mean, std);
  }

  transformRow(row: readonly number[]): number[] {
    return row.map((v, j) => (v - this.mean[j]) / this.std[j]);
  }

  transform(X: readonly number[][]): number[][] {
    return X.map((r) => this.transformRow(r));
  }
}

// ── Model 1: multinomial logistic regression (L2) ────────────────────────────

export interface LogRegOptions {
  /** Inverse regularization strength (sklearn `C`); larger = weaker L2. */
  C: number;
  /** Full-batch gradient-descent epochs. */
  epochs?: number;
  /** Learning rate (features are standardized, so a fixed rate is stable). */
  learningRate?: number;
}

/**
 * L2-regularized multinomial logistic regression, fit by deterministic full-
 * batch gradient descent on the softmax cross-entropy with an L2 penalty of
 * `1/C` on the weights (sklearn-style inverse strength). Zero-initialized, so
 * the fit is reproducible.
 */
export class MultinomialLogReg implements Classifier {
  private readonly W: number[][]; // K × D
  private readonly b: number[]; // K

  private constructor(W: number[][], b: number[]) {
    this.W = W;
    this.b = b;
  }

  static fit(X: readonly number[][], y: readonly number[], opts: LogRegOptions): MultinomialLogReg {
    const n = X.length;
    const d = n > 0 ? X[0].length : 0;
    const K = CLASS_COUNT;
    const epochs = opts.epochs ?? 300;
    const lr = opts.learningRate ?? 0.5;
    const lambda = opts.C > 0 ? 1 / opts.C : 0;

    const W: number[][] = Array.from({ length: K }, () => new Array(d).fill(0));
    const b: number[] = new Array(K).fill(0);
    if (n === 0 || d === 0) return new MultinomialLogReg(W, b);

    for (let epoch = 0; epoch < epochs; epoch++) {
      const gradW: number[][] = Array.from({ length: K }, () => new Array(d).fill(0));
      const gradB: number[] = new Array(K).fill(0);

      for (let i = 0; i < n; i++) {
        const xi = X[i];
        const logits = new Array(K).fill(0);
        for (let k = 0; k < K; k++) {
          let s = b[k];
          for (let j = 0; j < d; j++) s += W[k][j] * xi[j];
          logits[k] = s;
        }
        const p = softmax(logits);
        for (let k = 0; k < K; k++) {
          const err = p[k] - (y[i] === k ? 1 : 0);
          gradB[k] += err;
          for (let j = 0; j < d; j++) gradW[k][j] += err * xi[j];
        }
      }

      for (let k = 0; k < K; k++) {
        b[k] -= lr * (gradB[k] / n);
        for (let j = 0; j < d; j++) {
          // Mean cross-entropy gradient + L2 (bias is not penalized).
          W[k][j] -= lr * (gradW[k][j] / n + lambda * W[k][j]);
        }
      }
    }
    return new MultinomialLogReg(W, b);
  }

  predictProba(x: readonly number[]): number[] {
    const logits = this.W.map((wk, k) => {
      let s = this.b[k];
      for (let j = 0; j < wk.length; j++) s += wk[j] * x[j];
      return s;
    });
    return softmax(logits);
  }

  predictClass(x: readonly number[]): number {
    return argmax(this.predictProba(x));
  }
}

// ── Model 2: shallow gradient-boosted trees (multiclass) ─────────────────────

interface TreeNode {
  /** Leaf value when `feature < 0`; otherwise an internal split. */
  feature: number;
  threshold: number;
  left: TreeNode | null;
  right: TreeNode | null;
  value: number;
}

/**
 * CART regression tree (squared-error), depth-limited. Deterministic: candidate
 * thresholds are the sorted-value midpoints, ties on split gain break to the
 * first feature/threshold seen. Fits the pseudo-residual of one boosting round.
 */
class RegressionTree {
  private readonly root: TreeNode;

  private constructor(root: TreeNode) {
    this.root = root;
  }

  static fit(X: readonly number[][], target: readonly number[], maxDepth: number, minLeaf: number): RegressionTree {
    const indices = X.map((_, i) => i);
    const root = RegressionTree.build(X, target, indices, maxDepth, minLeaf, 0);
    return new RegressionTree(root);
  }

  private static leaf(target: readonly number[], indices: number[]): TreeNode {
    let sum = 0;
    for (const i of indices) sum += target[i];
    const value = indices.length > 0 ? sum / indices.length : 0;
    return { feature: -1, threshold: 0, left: null, right: null, value };
  }

  private static build(
    X: readonly number[][],
    target: readonly number[],
    indices: number[],
    maxDepth: number,
    minLeaf: number,
    depth: number,
  ): TreeNode {
    if (depth >= maxDepth || indices.length < 2 * minLeaf) return RegressionTree.leaf(target, indices);

    const d = X[0].length;
    let bestFeature = -1;
    let bestThreshold = 0;
    let bestSse = Infinity;
    let bestLeft: number[] = [];
    let bestRight: number[] = [];

    for (let f = 0; f < d; f++) {
      const sorted = [...indices].sort((a, b) => X[a][f] - X[b][f]);
      // Total sums for the running left/right SSE decomposition.
      let totalSum = 0;
      let totalSumSq = 0;
      for (const i of sorted) {
        totalSum += target[i];
        totalSumSq += target[i] * target[i];
      }
      let leftSum = 0;
      let leftSumSq = 0;
      const total = sorted.length;
      for (let s = 0; s < total - 1; s++) {
        const i = sorted[s];
        leftSum += target[i];
        leftSumSq += target[i] * target[i];
        const leftCount = s + 1;
        const rightCount = total - leftCount;
        if (leftCount < minLeaf || rightCount < minLeaf) continue;
        // No split between equal feature values (threshold would be degenerate).
        if (X[sorted[s]][f] === X[sorted[s + 1]][f]) continue;
        const rightSum = totalSum - leftSum;
        const rightSumSq = totalSumSq - leftSumSq;
        const leftSse = leftSumSq - (leftSum * leftSum) / leftCount;
        const rightSse = rightSumSq - (rightSum * rightSum) / rightCount;
        const sse = leftSse + rightSse;
        if (sse < bestSse - 1e-12) {
          bestSse = sse;
          bestFeature = f;
          bestThreshold = (X[sorted[s]][f] + X[sorted[s + 1]][f]) / 2;
          bestLeft = sorted.slice(0, leftCount);
          bestRight = sorted.slice(leftCount);
        }
      }
    }

    if (bestFeature < 0) return RegressionTree.leaf(target, indices);
    return {
      feature: bestFeature,
      threshold: bestThreshold,
      left: RegressionTree.build(X, target, bestLeft, maxDepth, minLeaf, depth + 1),
      right: RegressionTree.build(X, target, bestRight, maxDepth, minLeaf, depth + 1),
      value: 0,
    };
  }

  predict(x: readonly number[]): number {
    let node = this.root;
    while (node.feature >= 0) {
      node = x[node.feature] < node.threshold ? node.left! : node.right!;
    }
    return node.value;
  }
}

export interface GbmOptions {
  nEstimators: number;
  maxDepth?: number;
  learningRate?: number;
  minLeaf?: number;
}

/**
 * Shallow multiclass gradient boosting (pre-reg §4: `max_depth ≤ 3`,
 * `n_estimators ∈ {100, 200}`, `learning_rate = 0.05`). One regression tree per
 * class per round is fit to the softmax pseudo-residual `(y_onehot − p)`; class
 * scores accumulate `learningRate × tree.predict`. Deterministic (no subsample).
 */
export class ShallowGBM implements Classifier {
  private readonly trees: RegressionTree[][]; // rounds × K
  private readonly learningRate: number;
  private readonly init: number[]; // K log-prior

  private constructor(trees: RegressionTree[][], learningRate: number, init: number[]) {
    this.trees = trees;
    this.learningRate = learningRate;
    this.init = init;
  }

  static fit(X: readonly number[][], y: readonly number[], opts: GbmOptions): ShallowGBM {
    const n = X.length;
    const K = CLASS_COUNT;
    const rounds = opts.nEstimators;
    const maxDepth = opts.maxDepth ?? 3;
    const lr = opts.learningRate ?? 0.05;
    const minLeaf = opts.minLeaf ?? 5;

    // Class log-priors as the initial score (a sensible constant baseline).
    const counts = new Array(K).fill(0);
    for (const c of y) counts[c]++;
    const init = counts.map((c) => Math.log((c + 1) / (n + K)));

    const F: number[][] = X.map(() => [...init]); // current scores per sample
    const trees: RegressionTree[][] = [];
    if (n === 0) return new ShallowGBM(trees, lr, init);

    for (let m = 0; m < rounds; m++) {
      const roundTrees: RegressionTree[] = [];
      // Softmax probabilities for every sample under the current scores.
      const P: number[][] = F.map((f) => softmax(f));
      for (let k = 0; k < K; k++) {
        const residual = new Array(n);
        for (let i = 0; i < n; i++) residual[i] = (y[i] === k ? 1 : 0) - P[i][k];
        const tree = RegressionTree.fit(X, residual, maxDepth, minLeaf);
        roundTrees.push(tree);
        for (let i = 0; i < n; i++) F[i][k] += lr * tree.predict(X[i]);
      }
      trees.push(roundTrees);
    }
    return new ShallowGBM(trees, lr, init);
  }

  predictProba(x: readonly number[]): number[] {
    const F = [...this.init];
    for (const round of this.trees) {
      for (let k = 0; k < round.length; k++) F[k] += this.learningRate * round[k].predict(x);
    }
    return softmax(F);
  }

  predictClass(x: readonly number[]): number {
    return argmax(this.predictProba(x));
  }
}
