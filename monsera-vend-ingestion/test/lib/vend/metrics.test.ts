import { computeVendMetrics, VendForMetrics } from '@/lib/vend/metrics';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-31T00:00:00.000Z');
const vend = (amountKobo: number, daysAgo: number, vendStatus: 'SUCCESSFUL' | 'FAILED' = 'SUCCESSFUL'): VendForMetrics => ({
  amountKobo,
  vendedAt: new Date(NOW.getTime() - daysAgo * DAY),
  vendStatus,
});

describe('computeVendMetrics', () => {
  it('returns all zeros for an empty history', () => {
    expect(computeVendMetrics([], NOW)).toEqual({
      vendCountLast60Days: 0,
      daysSinceLastVend: 0,
      vendFrequency: 0,
      medianVendAmountKobo: 0,
      vendAmountVolatility: 0,
      interVendVarianceDays: 0,
      failedVendRatio: 0,
    });
  });

  it('counts only successful vends inside the 60-day window', () => {
    const result = computeVendMetrics(
      [vend(1000, 1), vend(1000, 5), vend(1000, 10), vend(1000, 61), vend(1000, 2, 'FAILED')],
      NOW
    );
    expect(result.vendCountLast60Days).toBe(3);
  });

  it('includes a vend exactly 60 days old', () => {
    expect(computeVendMetrics([vend(1000, 60)], NOW).vendCountLast60Days).toBe(1);
  });

  it('is independent of input order', () => {
    const list = [vend(1000, 10), vend(3000, 8), vend(2000, 2)];
    expect(computeVendMetrics([...list].reverse(), NOW)).toEqual(computeVendMetrics(list, NOW));
  });

  it('rounds vendFrequency as count / 2', () => {
    const five = [1, 2, 3, 4, 5].map((d) => vend(1000, d));
    expect(computeVendMetrics(five, NOW).vendFrequency).toBe(3);
    expect(computeVendMetrics(five.slice(0, 4), NOW).vendFrequency).toBe(2);
  });

  describe('daysSinceLastVend', () => {
    it('uses the most recent SUCCESSFUL vend, ignoring newer failed ones', () => {
      const result = computeVendMetrics([vend(1000, 10), vend(1000, 20), vend(1000, 1, 'FAILED')], NOW);
      expect(result.daysSinceLastVend).toBe(10);
    });

    it('rounds partial days up', () => {
      expect(computeVendMetrics([vend(1000, 9.5)], NOW).daysSinceLastVend).toBe(10);
    });

    it('is 0 when there are no successful vends', () => {
      expect(computeVendMetrics([vend(1000, 3, 'FAILED')], NOW).daysSinceLastVend).toBe(0);
    });
  });

  describe('medianVendAmountKobo', () => {
    it('takes the middle value for an odd count', () => {
      expect(computeVendMetrics([vend(1000, 1), vend(3000, 2), vend(2000, 3)], NOW).medianVendAmountKobo).toBe(2000);
    });

    it('averages the two middle values for an even count', () => {
      const result = computeVendMetrics([vend(1000, 1), vend(2000, 2), vend(3000, 3), vend(5000, 4)], NOW);
      expect(result.medianVendAmountKobo).toBe(2500);
    });

    it('ignores failed vends', () => {
      expect(computeVendMetrics([vend(1000, 1), vend(9_000_000, 2, 'FAILED')], NOW).medianVendAmountKobo).toBe(1000);
    });
  });

  describe('vendAmountVolatility', () => {
    it('is standard deviation over median, as a whole percent', () => {
      // amounts 1000 and 3000: mean 2000, std 1000, median 2000 -> 50
      expect(computeVendMetrics([vend(1000, 1), vend(3000, 2)], NOW).vendAmountVolatility).toBe(50);
    });

    it('is 0 for a single vend', () => {
      expect(computeVendMetrics([vend(1000, 1)], NOW).vendAmountVolatility).toBe(0);
    });
  });

  describe('interVendVarianceDays', () => {
    it('is the variance of the gaps between successful vends', () => {
      // vends 10, 8 and 2 days ago -> gaps 2 and 6 -> mean 4 -> variance 4
      expect(computeVendMetrics([vend(1000, 10), vend(1000, 8), vend(1000, 2)], NOW).interVendVarianceDays).toBe(4);
    });

    it('is 0 with fewer than three successful vends', () => {
      expect(computeVendMetrics([vend(1000, 10), vend(1000, 2)], NOW).interVendVarianceDays).toBe(0);
    });
  });

  describe('failedVendRatio', () => {
    it('is failed attempts over all attempts in the window, as a whole percent', () => {
      const result = computeVendMetrics([vend(1000, 1), vend(1000, 2), vend(1000, 3), vend(1000, 4, 'FAILED')], NOW);
      expect(result.failedVendRatio).toBe(25);
    });

    it('rounds to the nearest whole percent', () => {
      const result = computeVendMetrics([vend(1000, 1), vend(1000, 2), vend(1000, 3, 'FAILED')], NOW);
      expect(result.failedVendRatio).toBe(33);
    });

    it('is 100 when every attempt failed, while success-based metrics stay 0', () => {
      const result = computeVendMetrics([vend(1000, 1, 'FAILED'), vend(1000, 2, 'FAILED')], NOW);
      expect(result.failedVendRatio).toBe(100);
      expect(result.vendCountLast60Days).toBe(0);
      expect(result.daysSinceLastVend).toBe(0);
    });

    it('ignores failures older than the window', () => {
      expect(computeVendMetrics([vend(1000, 1), vend(1000, 70, 'FAILED')], NOW).failedVendRatio).toBe(0);
    });

    it('is 0 with no vends at all', () => {
      expect(computeVendMetrics([], NOW).failedVendRatio).toBe(0);
    });
  });
});