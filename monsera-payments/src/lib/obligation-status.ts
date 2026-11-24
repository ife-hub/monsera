/**
 * Spec §5 — thin compatibility layer over lib/recovery-window.ts, which holds
 * the one implementation of the recovery window and status rules.
 */
import prisma from './prisma';
import {
  computeWindows,
  dailyRateKobo,
  SPEC_WINDOW_PARAMETERS,
  statusForElapsed,
  type StatusWindows,
  type TariffBand,
  type WindowParameters,
} from './recovery-window';

export type ObligationStatus = 'Current' | 'Watch' | 'Delayed' | 'Default' | 'Discharged';
export type { StatusWindows, TariffBand, WindowParameters };

/** Windows for an advance, from a daily burn rate in naira (§5.2). */
export function computeStatusWindows(
  disbursedKobo: number,
  _band: TariffBand,
  dailyBurnNaira: number,
  disbursementDate: Date,
  params: WindowParameters = SPEC_WINDOW_PARAMETERS
): StatusWindows {
  return computeWindows(disbursedKobo, dailyBurnNaira * 100, disbursementDate, params);
}

/** Status from elapsed calendar days less closed suspended days. */
export function evaluateStatus(
  disbursementDate: Date,
  suspendedDays: number,
  windows: Pick<StatusWindows, 'watchDays' | 'delayedDays' | 'defaultDays'>,
  remainingKobo: number,
  now: Date = new Date()
): ObligationStatus {
  if (remainingKobo === 0) return 'Discharged';
  const elapsed = Math.max(0, Math.floor((now.getTime() - disbursementDate.getTime()) / 86_400_000) - suspendedDays);
  return statusForElapsed(elapsed, windows);
}

/** Recovery-window parameters in force now (RecoveryWindowParameters), else §5.2 as written. */
export async function getActiveWindowParameters(): Promise<WindowParameters> {
  const row = await prisma.recoveryWindowParameters.findFirst({
    where: { isActive: true, effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row) return SPEC_WINDOW_PARAMETERS;
  return {
    version: row.version,
    watchMultiplier: Number(row.watchMultiplier),
    delayedMultiplier: Number(row.delayedMultiplier),
    defaultMultiplier: Number(row.defaultMultiplier),
    minWatchDays: row.minWatchDays,
    minDelayedDays: row.minDelayedDays,
    minDefaultDays: row.minDefaultDays,
    maxDefaultDays: row.maxDefaultDays,
  };
}

/** Daily burn (kobo) for a band at a date: latest effective BurnRate row, else the §5.1 band default. */
export async function getDailyRateKobo(band: TariffBand, asAt: Date): Promise<number> {
  const rates = await prisma.burnRate.findMany({
    where: { band, effectiveFrom: { lte: asAt } },
    orderBy: { effectiveFrom: 'desc' },
    take: 1,
    select: { band: true, dailyBurnNaira: true, effectiveFrom: true },
  });
  return dailyRateKobo(band, rates, asAt);
}
