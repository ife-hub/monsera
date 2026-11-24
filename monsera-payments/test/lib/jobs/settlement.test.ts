jest.mock('@sentry/nextjs', () => ({ __esModule: true, captureException: jest.fn() }));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    transactions: { findMany: jest.fn() },
    monseraEarnings: { findMany: jest.fn() },
    customer: { findMany: jest.fn() },
    audit: { create: jest.fn() },
  },
}));

jest.mock('@/lib/reconciliation', () => ({ __esModule: true, controllingIdentity: jest.fn() }));

import * as Sentry from '@sentry/nextjs';
import { controllingIdentity } from '@/lib/reconciliation';
import prisma from '@/lib/prisma';
import { runSettlement } from '@/lib/jobs/settlement';

const mockPrisma = prisma as any;
const mockSentry = Sentry as unknown as { captureException: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.transactions.findMany.mockResolvedValue([]);
  mockPrisma.monseraEarnings.findMany.mockResolvedValue([]);
  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.audit.create.mockResolvedValue({});
  (controllingIdentity as jest.Mock).mockResolvedValue({ holds: true, discrepancyKobo: 0, leftSideKobo: 0, rightSideKobo: 0 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('runSettlement', () => {
  it('closes the previous WAT day (§8.3) when run at 02:00 WAT', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T01:00:00.000Z')); // 02:00 WAT on the 15th
    await runSettlement();

    // 14 March WAT = 13 Mar 23:00 UTC up to (not including) 14 Mar 23:00 UTC
    const { gte, lt } = mockPrisma.transactions.findMany.mock.calls[0][0].where.date;
    expect(gte.toISOString()).toBe('2026-03-13T23:00:00.000Z');
    expect(lt.toISOString()).toBe('2026-03-14T23:00:00.000Z');
  });

  it('uses the WAT date, not the UTC date, just after midnight WAT', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-14T23:30:00.000Z')); // 00:30 WAT on the 15th
    expect((await runSettlement()).reportingDate).toBe('2026-03-14');
  });

  it('alerts and does not complete when the controlling identity is breached (§8.2)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T01:00:00.000Z'));
    (controllingIdentity as jest.Mock).mockResolvedValue({ holds: false, discrepancyKobo: 500, leftSideKobo: 1000, rightSideKobo: 500 });

    await expect(runSettlement()).rejects.toThrow(/SETTLEMENT HALTED/);
    expect(mockPrisma.transactions.findMany).not.toHaveBeenCalled();
    expect(mockSentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { job: 'settlement', type: 'controlling_identity_breach' } }));
  });

  it('reports the correct prior day at other run times', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T14:37:00.000Z'));
    const result = await runSettlement();
    expect(result.reportingDate).toBe('2026-03-14');
  });

  it('computes totals from debits and repayments within the closed window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T01:00:00.000Z'));
    mockPrisma.transactions.findMany
      .mockResolvedValueOnce([{ obligationKobo: 550000, disbursedKobo: 500000, serviceKobo: 50000, amount: 5500 }])
      .mockResolvedValueOnce([{ obligationKobo: 200000, disbursedKobo: 180000, serviceKobo: 20000, amount: 2000 }]);
    mockPrisma.monseraEarnings.findMany.mockResolvedValue([{ amount: 500 }]);
    mockPrisma.customer.findMany.mockResolvedValue([{ outstanding: 1000 }, { outstanding: 2000 }]);

    const result = await runSettlement();

    expect(result.totalObligationKobo).toBe(550000);
    expect(result.totalDisbursedKobo).toBe(500000);
    expect(result.totalRecoveredKobo).toBe(200000);
    expect(result.totalFeesKobo).toBe(50000);
    expect(result.totalOutstandingKobo).toBe(300000);
  });

  it('does not alert when service accrued matches expected (within 1 kobo)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T01:00:00.000Z'));
    mockPrisma.transactions.findMany
      .mockResolvedValueOnce([{ obligationKobo: 100000, disbursedKobo: 90000, serviceKobo: 10000, amount: 1000 }])
      .mockResolvedValueOnce([]);

    const result = await runSettlement();
    expect(result.serviceDiscrepancyKobo).toBe(0);
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });

  it('alerts via Sentry and audit when service accrued diverges by more than 1 kobo', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T01:00:00.000Z'));
    mockPrisma.transactions.findMany
      .mockResolvedValueOnce([{ obligationKobo: 100000, disbursedKobo: 90000, serviceKobo: 8000, amount: 1000 }])
      .mockResolvedValueOnce([]);

    const result = await runSettlement();
    expect(result.serviceDiscrepancyKobo).toBe(2000);
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error), expect.objectContaining({ tags: { job: 'settlement', type: 'service_charge_discrepancy' } })
    );
  });

  it('propagates the job tag and rethrows on failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T01:00:00.000Z'));
    const error = new Error('DB down');
    mockPrisma.transactions.findMany.mockRejectedValue(error);

    await expect(runSettlement()).rejects.toThrow('DB down');
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      error, expect.objectContaining({ tags: { job: 'settlement' } })
    );
  });
});