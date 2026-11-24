/**
 * Spec §5 — Recovery Window and Obligation Status. The single implementation
 * used by disbursement, the daily status sweep, recovery and reconciliation.
 *
 *   E            = disbursed_naira / daily_burn_rate[band]   (expected days)
 *   watch_days   = max(2E, 5)
 *   delayed_days = max(4E, 10)
 *   default_days = min(max(6E, 21), 45)
 *
 * Multiples of E are rounded to whole days, which is how the spec's own
 * "resulting windows" table is computed (e.g. Band A ₦3,636: E = 3.3,
 * watch = 7, delayed = 13). Burn rates (BurnRate table) and the multipliers
 * and bounds (RecoveryWindowParameters table) are configuration, changeable
 * without a deployment. An obligation's windows are fixed at disbursement
 * with the configuration then in force.
 */
import type { ObligationStatus, TariffBand } from '@prisma/client';

export type { ObligationStatus, TariffBand };

/** Statuses that represent an open (undischarged) obligation. */
export type OpenStatus = Exclude<ObligationStatus, 'Discharged'>;

export const MS_PER_DAY = 86_400_000;

/** §5.1 daily burn by band, in kobo/day — used when no BurnRate row applies. */
export const DEFAULT_DAILY_CONSUMPTION_KOBO: Record<TariffBand, number> = {
  A: 110_000, // ₦1,100
  B: 65_000, // ₦650
  C: 65_000, // ₦650
};

export interface BurnRateRow {
  band: TariffBand;
  dailyBurnNaira: number;
  effectiveFrom: Date;
}

export interface WindowParameters {
  version: string;
  watchMultiplier: number;
  delayedMultiplier: number;
  defaultMultiplier: number;
  minWatchDays: number;
  minDelayedDays: number;
  minDefaultDays: number;
  maxDefaultDays: number;
}

/** §5.2 as written — used when no RecoveryWindowParameters row is active. */
export const SPEC_WINDOW_PARAMETERS: WindowParameters = {
  version: 'spec-5.2',
  watchMultiplier: 2,
  delayedMultiplier: 4,
  defaultMultiplier: 6,
  minWatchDays: 5,
  minDelayedDays: 10,
  minDefaultDays: 21,
  maxDefaultDays: 45,
};

/**
 * Daily consumption rate (kobo) for a band as at a given date: the most recent
 * BurnRate row with effectiveFrom <= asAt, else the §5.1 default for that band.
 */
export function dailyRateKobo(band: TariffBand, rates: BurnRateRow[], asAt: Date): number {
  let best: BurnRateRow | undefined;
  for (const r of rates) {
    if (r.band !== band || r.effectiveFrom > asAt) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best ? best.dailyBurnNaira * 100 : DEFAULT_DAILY_CONSUMPTION_KOBO[band];
}

export interface Thresholds {
  expectedDays: number;
  watchDays: number;
  delayedDays: number;
  defaultDays: number;
}

/**
 * Whole-day thresholds for an advance. Watch <= Delayed <= Default is also
 * enforced; within the pilot range (₦1,818–₦6,363 disbursed) the formula
 * already satisfies it, so this only guards misconfiguration.
 */
export function recoveryThresholds(
  disbursedKobo: number,
  dailyRate: number,
  p: WindowParameters = SPEC_WINDOW_PARAMETERS
): Thresholds {
  const E = disbursedKobo / dailyRate;
  const defaultDays = Math.min(Math.max(Math.round(p.defaultMultiplier * E), p.minDefaultDays), p.maxDefaultDays);
  const delayedDays = Math.min(Math.max(Math.round(p.delayedMultiplier * E), p.minDelayedDays), defaultDays);
  const watchDays = Math.min(Math.max(Math.round(p.watchMultiplier * E), p.minWatchDays), delayedDays);
  return { expectedDays: E, watchDays, delayedDays, defaultDays };
}

export interface StatusWindows extends Thresholds {
  expectedRecoveryDate: Date;
  watchDate: Date;
  delayedDate: Date;
  defaultDate: Date;
}

export function computeWindows(
  disbursedKobo: number,
  dailyRate: number,
  disbursementDate: Date,
  p: WindowParameters = SPEC_WINDOW_PARAMETERS
): StatusWindows {
  const t = recoveryThresholds(disbursedKobo, dailyRate, p);
  const at = (days: number) => new Date(disbursementDate.getTime() + days * MS_PER_DAY);
  return {
    ...t,
    expectedRecoveryDate: at(t.expectedDays),
    watchDate: at(t.watchDays),
    delayedDate: at(t.delayedDays),
    defaultDate: at(t.defaultDays),
  };
}

// ── Clock suspension (§5.3) ───────────────────────────────────────────────

/** The four §5.3 grounds, as stored in ObligationSuspension.reason. */
export const SUSPENSION_REASONS = {
  meter_unavailable: 'Meter disconnected, faulted, or under investigation for reasons unrelated to the advance',
  ring_fence_changed: 'Ring-fence over the meter released or modified',
  customer_dispute: 'Customer dispute in respect of the advance logged and unresolved',
  disco_systems_unavailable: 'DisCo vending or settlement systems unavailable for more than 24 consecutive hours',
} as const;
export type SuspensionReason = keyof typeof SUSPENSION_REASONS;

/** §5.3: an outage only suspends the clock once it exceeds 24 consecutive hours. */
export const SYSTEMS_OUTAGE_THRESHOLD_MS = 24 * 3_600_000;

export interface SuspensionInterval {
  reason: string;
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * Milliseconds of suspended time between `from` and `now`, reconstructed from
 * the recorded suspension events. Overlapping suspensions (e.g. a dispute
 * during a disconnection) are merged so time is never subtracted twice. A
 * systems-outage suspension counts in full once it lasts more than 24 hours,
 * and not at all before then.
 */
export function suspendedMs(suspensions: SuspensionInterval[], from: Date, now: Date): number {
  const intervals: Array<[number, number]> = [];
  for (const s of suspensions) {
    const start = Math.max(s.startedAt.getTime(), from.getTime());
    const end = Math.min((s.endedAt ?? now).getTime(), now.getTime());
    if (end <= start) continue;
    if (s.reason === 'disco_systems_unavailable') {
      const fullLength = (s.endedAt ?? now).getTime() - s.startedAt.getTime();
      if (fullLength <= SYSTEMS_OUTAGE_THRESHOLD_MS) continue;
    }
    intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const [start, end] of intervals) {
    if (start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/** Whole days elapsed on the recovery clock: calendar time less suspended time. */
export function elapsedRecoveryDays(
  disbursementDate: Date,
  suspensions: SuspensionInterval[] = [],
  now: Date = new Date()
): number {
  const ms = now.getTime() - disbursementDate.getTime() - suspendedMs(suspensions, disbursementDate, now);
  return Math.max(0, Math.floor(ms / MS_PER_DAY));
}

/** Status for a given number of elapsed days against whole-day thresholds (§5.2 table). */
export function statusForElapsed(
  elapsedDays: number,
  t: Pick<Thresholds, 'watchDays' | 'delayedDays' | 'defaultDays'>
): OpenStatus {
  if (elapsedDays >= t.defaultDays) return 'Default';
  if (elapsedDays >= t.delayedDays) return 'Delayed';
  if (elapsedDays >= t.watchDays) return 'Watch';
  return 'Current';
}

export interface StoredObligationWindows {
  disbursementDate: Date;
  watchDate: Date;
  delayedDate: Date;
  defaultDate: Date;
  suspensions?: SuspensionInterval[];
}

/** Thresholds as registered on the obligation at disbursement. */
export function storedThresholds(o: StoredObligationWindows) {
  const days = (d: Date) => Math.round((d.getTime() - o.disbursementDate.getTime()) / MS_PER_DAY);
  const defaultDays = days(o.defaultDate);
  const delayedDays = Math.min(days(o.delayedDate), defaultDays);
  const watchDays = Math.min(days(o.watchDate), delayedDays);
  return { watchDays, delayedDays, defaultDays };
}

/**
 * Current status of an open obligation from its registered windows and its
 * suspension history. Used by the status sweep, by recovery for a residual
 * balance (§4.6) and by reconciliation, so all three always agree.
 */
export function classifyObligation(
  o: StoredObligationWindows,
  now: Date = new Date()
): { status: OpenStatus; elapsedDays: number } {
  const elapsedDays = elapsedRecoveryDays(o.disbursementDate, o.suspensions ?? [], now);
  return { status: statusForElapsed(elapsedDays, storedThresholds(o)), elapsedDays };
}
