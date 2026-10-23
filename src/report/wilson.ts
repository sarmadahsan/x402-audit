/**
 * Binomial confidence intervals for the report.
 *
 * wilsonInterval: Wilson score interval for a proportion.
 * sampleSizeForHalfWidth: planning helper (smallest n reaching a target half-width).
 * dollarWeightedRate / dollarWeightedWilson: failure rate weighted by atomic amount.
 */

export const Z95 = 1.959964;

export interface Interval {
  p: number;
  lo: number;
  hi: number;
  halfWidth: number;
}

/**
 * Wilson score interval. `successes` may be fractional (used by the weighted
 * variant and by sampleSizeForHalfWidth). n <= 0 returns the uninformative
 * interval p=0, lo=0, hi=1.
 */
export function wilsonInterval(successes: number, n: number, z = Z95): Interval {
  if (!Number.isFinite(n) || n <= 0) return { p: 0, lo: 0, hi: 1, halfWidth: 0.5 };
  if (successes < 0 || successes > n || !Number.isFinite(successes)) {
    throw new RangeError(`wilsonInterval: successes must be in [0, n], got ${successes}/${n}`);
  }
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // At p=0 (p=1) the exact Wilson bound is 0 (1); pin it to avoid float residue.
  const lo = successes === 0 ? 0 : Math.max(0, center - margin);
  const hi = successes === n ? 1 : Math.min(1, center + margin);
  return { p, lo, hi, halfWidth: (hi - lo) / 2 };
}

/**
 * Smallest integer n whose Wilson half-width at the given true rate is <= halfWidth.
 * The half-width is monotone non-increasing in n for fixed p, so this uses
 * exponential search then binary search; the answer is identical to a step-1 scan.
 */
export function sampleSizeForHalfWidth(rate: number, halfWidth: number, z = Z95): number {
  if (!(rate >= 0 && rate <= 1)) throw new RangeError(`sampleSizeForHalfWidth: rate must be in [0,1], got ${rate}`);
  if (!(halfWidth > 0)) throw new RangeError(`sampleSizeForHalfWidth: halfWidth must be > 0, got ${halfWidth}`);
  const hw = (n: number) => wilsonInterval(rate * n, n, z).halfWidth;
  if (hw(1) <= halfWidth) return 1;
  let lo = 1; // hw(lo) > halfWidth
  let hi = 2;
  while (hw(hi) > halfWidth) {
    lo = hi;
    hi *= 2;
    if (hi > 2 ** 52) throw new RangeError("sampleSizeForHalfWidth: target half-width unreachable");
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (hw(mid) <= halfWidth) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface WeightedRow {
  weightAtomic: bigint;
  failed: boolean;
}

/** Precision used when turning bigint ratios into numbers. */
const SCALE = 10n ** 15n;

function ratio(num: bigint, den: bigint): number {
  if (den === 0n) return 0;
  return Number((num * SCALE) / den) / Number(SCALE);
}

function sums(rows: readonly WeightedRow[]): { total: bigint; failedTotal: bigint; sumSq: bigint } {
  let total = 0n;
  let failedTotal = 0n;
  let sumSq = 0n;
  for (const r of rows) {
    if (r.weightAtomic < 0n) throw new RangeError(`dollar-weighted rows must have non-negative weights, got ${r.weightAtomic}`);
    total += r.weightAtomic;
    sumSq += r.weightAtomic * r.weightAtomic;
    if (r.failed) failedTotal += r.weightAtomic;
  }
  return { total, failedTotal, sumSq };
}

/** Share of atomic value that failed. Empty or zero-weight input gives rate 0. */
export function dollarWeightedRate(rows: readonly WeightedRow[]): { rate: number; totalAtomic: bigint; failedAtomic: bigint } {
  const { total, failedTotal } = sums(rows);
  return { rate: ratio(failedTotal, total), totalAtomic: total, failedAtomic: failedTotal };
}

/**
 * Dollar-weighted failure rate with an approximate Wilson interval.
 *
 * APPROXIMATION: this uses Kish's effective sample size,
 *   n_eff = (sum w)^2 / sum(w^2),   p = sum(w * failed) / sum(w),
 * and plugs (p * n_eff, n_eff) into the ordinary Wilson formula. It treats the
 * weights as fixed and ignores any correlation between weight and failure, so
 * the coverage is not exact. The report labels this interval as approximate.
 * With equal weights n_eff = n and the result equals the count-weighted interval.
 */
export function dollarWeightedWilson(
  rows: readonly WeightedRow[],
  z = Z95,
): Interval & { effectiveN: number } {
  const { total, failedTotal, sumSq } = sums(rows);
  if (total === 0n || sumSq === 0n) return { p: 0, lo: 0, hi: 1, halfWidth: 0.5, effectiveN: 0 };
  const p = ratio(failedTotal, total);
  const effectiveN = ratio(total * total, sumSq);
  const w = wilsonInterval(Math.min(effectiveN, Math.max(0, p * effectiveN)), effectiveN, z);
  return { ...w, p, effectiveN };
}
