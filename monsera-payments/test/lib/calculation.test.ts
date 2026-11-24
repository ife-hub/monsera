import {
  calculateDisbursement,
  validateDisbursement,
  koboToNaira,
  RATE_BPS,
  MIN_OBLIGATION_KOBO,
  MAX_OBLIGATION_KOBO,
  DisbursementCalculation,
} from '@/lib/calculation';

describe('calculateDisbursement', () => {
  it('uses RATE_BPS by default when no rate is passed', () => {
    const withDefault = calculateDisbursement(5000);
    const withExplicit = calculateDisbursement(5000, RATE_BPS);
    expect(withDefault).toEqual(withExplicit);
  });

  it('converts naira to kobo before computing', () => {
    const calc = calculateDisbursement(5000, 1000);
    expect(calc.obligationKobo).toBe(500000);
  });

  it('floors disbursedKobo and gives the remainder to serviceKobo', () => {
    const calc = calculateDisbursement(5000, 1000);
    expect(calc.disbursedKobo).toBe(454545);
    expect(calc.serviceKobo).toBe(45455);
  });

  it('always satisfies disbursed + service === obligation, across a spread of amounts and rates', () => {
    const amounts = [1, 1.5, 99.99, 2000, 2000.01, 4999.99, 7000, 123456.78];
    const rates = [0, 1, 500, 1000, 2500, 9999];

    for (const naira of amounts) {
      for (const rateBps of rates) {
        const calc = calculateDisbursement(naira, rateBps);
        expect(calc.disbursedKobo + calc.serviceKobo).toBe(calc.obligationKobo);
      }
    }
  });

  it('rejects amounts with more than 2 decimal places instead of rounding them', () => {
    // obligation_kobo = naira * 100 must be exact (spec §2); a sub-kobo
    // amount is a malformed request, not something to guess at.
    expect(() => calculateDisbursement(20.005, 1000)).toThrow(/2 decimal places/);
    expect(calculateDisbursement(20.05, 1000).obligationKobo).toBe(2005);
  });

  it('produces zero service and full disbursement at a 0 bps rate', () => {
    const calc = calculateDisbursement(5000, 0);
    expect(calc.disbursedKobo).toBe(calc.obligationKobo);
    expect(calc.serviceKobo).toBe(0);
  });

  it('produces a non-negative serviceKobo even at very high rates', () => {
    const calc = calculateDisbursement(5000, 9999);
    expect(calc.serviceKobo).toBeGreaterThanOrEqual(0);
    expect(calc.disbursedKobo).toBeGreaterThan(0);
  });

  it('returns the rateBps that was actually used, on the result object', () => {
    const calc = calculateDisbursement(5000, 2500);
    expect(calc.rateBps).toBe(2500);
  });

  it('produces zero obligationKobo for zero naira input', () => {
    const calc = calculateDisbursement(0, 1000);
    expect(calc.obligationKobo).toBe(0);
    expect(calc.disbursedKobo).toBe(0);
    expect(calc.serviceKobo).toBe(0);
  });
});

describe('validateDisbursement', () => {
  const validCalc = (): DisbursementCalculation => calculateDisbursement(5000, 1000);

  it('does not throw for a valid mid-range calculation', () => {
    expect(() => validateDisbursement(validCalc())).not.toThrow();
  });

  it('throws when disbursed + service does not equal obligation', () => {
    const broken: DisbursementCalculation = {
      obligationKobo: 500000,
      disbursedKobo: 450000,
      serviceKobo: 40000,
      rateBps: 1000,
    };
    expect(() => validateDisbursement(broken)).toThrow(/invariant violated/i);
  });

  it('throws when disbursedKobo is zero', () => {
    const broken: DisbursementCalculation = {
      obligationKobo: 500000,
      disbursedKobo: 0,
      serviceKobo: 500000,
      rateBps: 1000,
    };
    expect(() => validateDisbursement(broken)).toThrow(/greater than zero/i);
  });

  it('throws when disbursedKobo is negative', () => {
    const broken: DisbursementCalculation = {
      obligationKobo: 500000,
      disbursedKobo: -100,
      serviceKobo: 500100,
      rateBps: 1000,
    };
    expect(() => validateDisbursement(broken)).toThrow(/greater than zero/i);
  });

  it('throws when obligationKobo is below MIN_OBLIGATION_KOBO', () => {
    const calc = calculateDisbursement((MIN_OBLIGATION_KOBO - 100) / 100, 1000);
    expect(() => validateDisbursement(calc)).toThrow(/below minimum/i);
  });

  it('does not throw exactly at MIN_OBLIGATION_KOBO', () => {
    const calc = calculateDisbursement(MIN_OBLIGATION_KOBO / 100, 1000);
    expect(() => validateDisbursement(calc)).not.toThrow();
  });

  it('throws when obligationKobo is above MAX_OBLIGATION_KOBO', () => {
    const calc = calculateDisbursement((MAX_OBLIGATION_KOBO + 100) / 100, 1000);
    expect(() => validateDisbursement(calc)).toThrow(/exceeds maximum/i);
  });

  it('does not throw exactly at MAX_OBLIGATION_KOBO', () => {
    const calc = calculateDisbursement(MAX_OBLIGATION_KOBO / 100, 1000);
    expect(() => validateDisbursement(calc)).not.toThrow();
  });

  it('checks the invariant before the min/max bounds, so a broken calc fails on the invariant message even if also out of range', () => {
    const broken: DisbursementCalculation = {
      obligationKobo: 100,
      disbursedKobo: 50,
      serviceKobo: 40,
      rateBps: 1000,
    };
    expect(() => validateDisbursement(broken)).toThrow(/invariant violated/i);
  });
});

describe('koboToNaira', () => {
  it('divides kobo by 100', () => {
    expect(koboToNaira(500000)).toBe(5000);
  });

  it('handles zero', () => {
    expect(koboToNaira(0)).toBe(0);
  });

  it('handles amounts that do not divide evenly', () => {
    expect(koboToNaira(12345)).toBeCloseTo(123.45, 5);
  });
});

describe('RATE_BPS / MIN_OBLIGATION_KOBO / MAX_OBLIGATION_KOBO env overrides', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('reads RATE_BPS from the environment at module load time', () => {
    process.env.RATE_BPS = '2000';
    const { RATE_BPS: reloadedRate } = require('@/lib/calculation');
    expect(reloadedRate).toBe(2000);
  });

  it('falls back to 1000 bps when RATE_BPS is unset', () => {
    delete process.env.RATE_BPS;
    const { RATE_BPS: reloadedRate } = require('@/lib/calculation');
    expect(reloadedRate).toBe(1000);
  });

  it('reads MIN_OBLIGATION_KOBO and MAX_OBLIGATION_KOBO from the environment', () => {
    process.env.MIN_OBLIGATION_KOBO = '100000';
    process.env.MAX_OBLIGATION_KOBO = '900000';
    const { MIN_OBLIGATION_KOBO: min, MAX_OBLIGATION_KOBO: max } = require('@/lib/calculation');
    expect(min).toBe(100000);
    expect(max).toBe(900000);
  });
});

describe('spec §2 / acceptance criterion 1 — pilot tiers at rate_bps = 1000', () => {
  // obligation, disbursed = floor(obligation * 10000 / 11000), service = remainder
  it.each([
    [2000, 200000, 181818, 18182],
    [4000, 400000, 363636, 36364],
    [7000, 700000, 636363, 63637],
  ])('₦%i -> obligation %i, disbursed %i, service %i (disbursed + service = obligation)', (naira, obligation, disbursed, service) => {
    const calc = calculateDisbursement(naira, 1000);
    expect(calc).toEqual({ obligationKobo: obligation, disbursedKobo: disbursed, serviceKobo: service, rateBps: 1000 });
    expect(calc.disbursedKobo + calc.serviceKobo).toBe(calc.obligationKobo);
    expect(() => validateDisbursement(calc, { minObligationKobo: 200000, maxObligationKobo: 700000, obligationTiersKobo: [200000, 400000, 700000] })).not.toThrow();
  });

  it('rejects an amount that is within min/max but not a configured tier', () => {
    const calc = calculateDisbursement(5000, 1000);
    expect(() => validateDisbursement(calc, { minObligationKobo: 200000, maxObligationKobo: 700000, obligationTiersKobo: [200000, 400000, 700000] }))
      .toThrow(/configured tiers: ₦2,000, ₦4,000, ₦7,000/);
  });

  it('allows any amount within min/max when no tiers are configured', () => {
    const calc = calculateDisbursement(5000, 1000);
    expect(() => validateDisbursement(calc, { minObligationKobo: 200000, maxObligationKobo: 700000, obligationTiersKobo: [] })).not.toThrow();
  });
});
