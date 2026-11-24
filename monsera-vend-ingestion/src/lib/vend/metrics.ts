export const METRICS_WINDOW_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface VendForMetrics {
  amountKobo: number;
  vendedAt: Date;
  vendStatus: 'SUCCESSFUL' | 'FAILED';
}

export interface VendMetrics {
  vendCountLast60Days: number;
  daysSinceLastVend: number;
  vendFrequency: number;
  medianVendAmountKobo: number;
  vendAmountVolatility: number;
  interVendVarianceDays: number;
  failedVendRatio: number;
}

/**
 * Pure function: turns a meter's vend history into scoring metrics.
 * Every metric except failedVendRatio uses SUCCESSFUL vends only, so a
 * failed attempt never counts as "the customer vended".
 * failedVendRatio = failed / all attempts in the window, as a whole percent.
 */
export function computeVendMetrics(vends: VendForMetrics[], now: Date = new Date()): VendMetrics {
  const windowStart = now.getTime() - METRICS_WINDOW_DAYS * MS_PER_DAY;
  const inWindow = vends.filter((v) => v.vendedAt.getTime() >= windowStart);

  const successful = inWindow
    .filter((v) => v.vendStatus === 'SUCCESSFUL')
    .sort((a, b) => b.vendedAt.getTime() - a.vendedAt.getTime()); // newest first
  const failedCount = inWindow.length - successful.length;

  const vendCountLast60Days = successful.length;
  const failedVendRatio = inWindow.length > 0 ? Math.round((failedCount / inWindow.length) * 100) : 0;

  let daysSinceLastVend = 0;
  if (successful.length > 0) {
    daysSinceLastVend = Math.ceil((now.getTime() - successful[0].vendedAt.getTime()) / MS_PER_DAY);
  }

  const vendFrequency = Math.round(vendCountLast60Days / 2);

  let medianVendAmountKobo = 0;
  if (successful.length > 0) {
    const amounts = successful.map((v) => v.amountKobo).sort((a, b) => a - b);
    const mid = Math.floor(amounts.length / 2);
    medianVendAmountKobo =
      amounts.length % 2 === 0 ? Math.round((amounts[mid - 1] + amounts[mid]) / 2) : amounts[mid];
  }

  let vendAmountVolatility = 0;
  if (successful.length > 1 && medianVendAmountKobo > 0) {
    const amounts = successful.map((v) => v.amountKobo);
    const mean = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    const variance = amounts.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / amounts.length;
    vendAmountVolatility = Math.round((Math.sqrt(variance) / medianVendAmountKobo) * 100);
  }

  let interVendVarianceDays = 0;
  if (successful.length > 2) {
    const dates = successful.map((v) => v.vendedAt.getTime()).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push((dates[i] - dates[i - 1]) / MS_PER_DAY);
    }
    const mean = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    interVendVarianceDays = Math.round(gaps.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / gaps.length);
  }

  return {
    vendCountLast60Days,
    daysSinceLastVend,
    vendFrequency,
    medianVendAmountKobo,
    vendAmountVolatility,
    interVendVarianceDays,
    failedVendRatio,
  };
}