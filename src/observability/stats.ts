/** Small numeric helpers shared by metrics and evaluation. All are NaN-free. */

/** Percentile with linear interpolation (p in [0,100]); null for empty input. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

export function mean(values: number[]): number | null {
  const xs = values.filter(v => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** num/den, or null when the denominator is 0 (never NaN/Infinity). */
export function ratio(num: number, den: number): number | null {
  return den > 0 && Number.isFinite(num) ? num / den : null;
}
