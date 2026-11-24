import {
  computeWindows,
  classifyObligation,
  dailyRateKobo,
  elapsedRecoveryDays,
  recoveryThresholds,
  statusForElapsed,
  suspendedMs,
  SPEC_WINDOW_PARAMETERS,
  MS_PER_DAY,
} from '@/lib/recovery-window';
import { computeStatusWindows, evaluateStatus } from '@/lib/obligation-status';

const A = 110_000; // ₦1,100/day in kobo
const BC = 65_000; // ₦650/day in kobo
const day = (n: number) => n * MS_PER_DAY;

describe('§5.2 resulting windows — the spec table, row by row (acceptance criterion 5)', () => {
  it.each([
    // band, disbursed kobo, daily rate, expected, watch, delayed, default
    ['A', 181818, A, 1.7, 5, 10, 21],
    ['A', 363636, A, 3.3, 7, 13, 21],
    ['A', 636363, A, 5.8, 12, 23, 35],
    ['B/C', 181818, BC, 2.8, 6, 11, 21],
    ['B/C', 363636, BC, 5.6, 11, 22, 34],
    ['B/C', 636363, BC, 9.8, 20, 39, 45],
  ])('Band %s, disbursed %i kobo -> E %f, watch %i, delayed %i, default %i', (_band, disbursed, rate, E, watch, delayed, deflt) => {
    const t = recoveryThresholds(disbursed, rate);
    expect(Number(t.expectedDays.toFixed(1))).toBe(E);
    expect(t).toMatchObject({ watchDays: watch, delayedDays: delayed, defaultDays: deflt });
  });

  it('turns thresholds into dates at whole days from disbursement', () => {
    const disbursed = new Date('2026-01-01T09:00:00Z');
    const w = computeWindows(363636, A, disbursed);
    expect(w.watchDate.toISOString()).toBe('2026-01-08T09:00:00.000Z');
    expect(w.delayedDate.toISOString()).toBe('2026-01-14T09:00:00.000Z');
    expect(w.defaultDate.toISOString()).toBe('2026-01-22T09:00:00.000Z');
  });

  it('applies the status table: Current < watch <= Watch < delayed <= Delayed < default <= Default', () => {
    const t = { watchDays: 7, delayedDays: 13, defaultDays: 21 };
    expect([0, 6, 7, 12, 13, 20, 21, 60].map((d) => statusForElapsed(d, t)))
      .toEqual(['Current', 'Current', 'Watch', 'Watch', 'Delayed', 'Delayed', 'Default', 'Default']);
  });

  it('uses configured multipliers and bounds (recalibration without deployment)', () => {
    const custom = { ...SPEC_WINDOW_PARAMETERS, version: 'x', watchMultiplier: 3, minWatchDays: 8 };
    expect(recoveryThresholds(363636, A, custom).watchDays).toBe(10); // round(3 * 3.3) = 10
    expect(recoveryThresholds(181818, A, custom).watchDays).toBe(8); // floor of 8
  });

  it('keeps the windows ordered when a large advance would push Delayed past the 45-day cap', () => {
    const t = recoveryThresholds(800_000, BC); // E = 12.3, uncapped delayed 49
    expect(t.defaultDays).toBe(45);
    expect(t.delayedDays).toBeLessThanOrEqual(t.defaultDays);
  });
});

describe('§5.1 burn rates are configuration with per-band fallbacks', () => {
  it('falls back to ₦1,100 for Band A and ₦650 for B/C when no BurnRate row applies', () => {
    expect(dailyRateKobo('A', [], new Date())).toBe(110_000);
    expect(dailyRateKobo('B', [], new Date())).toBe(65_000);
    expect(dailyRateKobo('C', [], new Date())).toBe(65_000);
  });

  it('uses the latest rate effective at the disbursement date, not a later one', () => {
    const rates = [
      { band: 'A' as const, dailyBurnNaira: 1000, effectiveFrom: new Date('2026-01-01') },
      { band: 'A' as const, dailyBurnNaira: 1200, effectiveFrom: new Date('2026-03-01') },
    ];
    expect(dailyRateKobo('A', rates, new Date('2026-02-15'))).toBe(100_000);
    expect(dailyRateKobo('A', rates, new Date('2026-03-15'))).toBe(120_000);
  });
});

describe('§5.3 clock suspension', () => {
  const disbursed = new Date('2026-01-01T00:00:00Z');
  const at = (d: number) => new Date(disbursed.getTime() + day(d));

  it('stops the clock while a suspension is open', () => {
    const open = [{ reason: 'meter_unavailable', startedAt: at(3), endedAt: null }];
    expect(elapsedRecoveryDays(disbursed, open, at(10))).toBe(3);
  });

  it('subtracts closed suspensions and resumes the clock afterwards', () => {
    const closed = [{ reason: 'customer_dispute', startedAt: at(2), endedAt: at(7) }];
    expect(elapsedRecoveryDays(disbursed, closed, at(10))).toBe(5);
  });

  it('never subtracts overlapping suspensions twice', () => {
    const overlapping = [
      { reason: 'meter_unavailable', startedAt: at(2), endedAt: at(8) },
      { reason: 'customer_dispute', startedAt: at(5), endedAt: at(10) },
    ];
    expect(suspendedMs(overlapping, disbursed, at(20))).toBe(day(8)); // days 2–10
    expect(elapsedRecoveryDays(disbursed, overlapping, at(20))).toBe(12);
  });

  it('counts a DisCo systems outage only when it exceeds 24 consecutive hours', () => {
    const short = [{ reason: 'disco_systems_unavailable', startedAt: at(2), endedAt: new Date(at(2).getTime() + 20 * 3_600_000) }];
    const long = [{ reason: 'disco_systems_unavailable', startedAt: at(2), endedAt: at(5) }];
    expect(elapsedRecoveryDays(disbursed, short, at(10))).toBe(10);
    expect(elapsedRecoveryDays(disbursed, long, at(10))).toBe(7);
  });

  it('classifies from the registered windows and the suspension history', () => {
    const w = computeWindows(363636, A, disbursed); // watch 7, delayed 13, default 21
    const obligation = { disbursementDate: disbursed, watchDate: w.watchDate, delayedDate: w.delayedDate, defaultDate: w.defaultDate };
    expect(classifyObligation(obligation, at(14)).status).toBe('Delayed');
    const withDispute = { ...obligation, suspensions: [{ reason: 'customer_dispute', startedAt: at(5), endedAt: at(12) }] };
    // 14 calendar days less the 7-day dispute = 7 elapsed: Watch, not Delayed.
    expect(classifyObligation(withDispute, at(14))).toEqual({ status: 'Watch', elapsedDays: 7 });
  });
});

describe('lib/obligation-status compatibility layer', () => {
  it('computeStatusWindows takes a naira burn rate and matches the table', () => {
    const w = computeStatusWindows(636363, 'B', 650, new Date('2026-01-01'));
    expect(w).toMatchObject({ watchDays: 20, delayedDays: 39, defaultDays: 45 });
  });

  it('evaluateStatus reports Discharged once nothing remains', () => {
    const w = computeStatusWindows(181818, 'B', 650, new Date('2020-01-01'));
    expect(evaluateStatus(new Date('2020-01-01'), 0, w, 0)).toBe('Discharged');
    expect(evaluateStatus(new Date('2020-01-01'), 0, w, 100)).toBe('Default');
  });
});
