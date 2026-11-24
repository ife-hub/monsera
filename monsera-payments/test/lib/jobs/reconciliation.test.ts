jest.mock('@sentry/nextjs', () => ({ __esModule: true, captureException: jest.fn(), captureMessage: jest.fn() }));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    obligation: { findMany: jest.fn() },
    audit: { create: jest.fn() },
    reconciliationRun: { create: jest.fn() },
  },
}));

// The ledger arithmetic itself runs in SQL and is exercised against a real
// database in tests/integration/ledger.int.test.ts. Here: orchestration.
jest.mock('@/lib/reconciliation', () => ({
  __esModule: true,
  controllingIdentity: jest.fn(),
  dailyVerification: jest.fn(),
}));

import * as Sentry from '@sentry/nextjs';
import prisma from '@/lib/prisma';
import { controllingIdentity, dailyVerification } from '@/lib/reconciliation';
import { runReconciliation } from '@/lib/jobs/reconciliation';
import { computeWindows } from '@/lib/recovery-window';

const mockPrisma = prisma as any;
const mockSentry = Sentry as unknown as { captureException: jest.Mock; captureMessage: jest.Mock };
const DAY = 86_400_000;

const identity = (overrides: Partial<any> = {}) => ({
  asOf: new Date().toISOString(), walletAKobo: 800_000, walletBKobo: 110_000, outstandingObligationsKobo: 110_000,
  leftSideKobo: 1_020_000, floatDeployedKobo: 1_000_000, commissionAccruedKobo: 20_000, commissionPaidOutKobo: 0,
  commissionNotYetPaidOutKobo: 20_000, rightSideKobo: 1_020_000, discrepancyKobo: 0, holds: true, ...overrides,
});
const verification = (overrides: Partial<any> = {}) => ({
  obligationsCreated: 1, obligationsWithoutDisbursement: [], recoveriesSettled: 1, recoveriesWithoutObligation: [],
  walletBRecoveriesWithoutRecoveryRows: [], advancesIssued: { count: 1, obligationKobo: 220_000, disbursedKobo: 200_000 },
  recoveriesEffected: { count: 1, amountKobo: 110_000 }, sweepMovements: { count: 0, principalKobo: 0 }, passed: true, ...overrides,
});
const openObligation = (daysAgo: number, status: string) => {
  const disbursementDate = new Date(Date.now() - daysAgo * DAY);
  const w = computeWindows(181818, 65_000, disbursementDate); // watch 6, delayed 11, default 21
  return { id: daysAgo, meterToken: `MT-${daysAgo}`, status, disbursementDate, watchDate: w.watchDate, delayedDate: w.delayedDate, defaultDate: w.defaultDate, suspensions: [] };
};

beforeEach(() => {
  jest.clearAllMocks();
  (controllingIdentity as jest.Mock).mockResolvedValue(identity());
  (dailyVerification as jest.Mock).mockResolvedValue(verification());
  mockPrisma.obligation.findMany.mockResolvedValue([]);
  mockPrisma.audit.create.mockResolvedValue({});
  mockPrisma.reconciliationRun.create.mockResolvedValue({});
});

describe('runReconciliation (daily, §8.1)', () => {
  it('reconciles the requested WAT day and records a passed run', async () => {
    const result = await runReconciliation('2026-03-14');

    const [start, end] = (dailyVerification as jest.Mock).mock.calls[0];
    expect(start.toISOString()).toBe('2026-03-13T23:00:00.000Z'); // 00:00 WAT
    expect(end.toISOString()).toBe('2026-03-14T23:00:00.000Z');
    expect(result).toMatchObject({ passed: true, hasDiscrepancy: false, day: '2026-03-14' });
    expect(mockPrisma.reconciliationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'daily', period: '2026-03-14', passed: true }),
    });
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringContaining('Reconciliation passed (2026-03-14 WAT)') }) })
    );
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });

  it('alerts via Sentry and the audit table when the controlling identity is breached', async () => {
    (controllingIdentity as jest.Mock).mockResolvedValue(identity({ holds: false, discrepancyKobo: 50_000, leftSideKobo: 970_000 }));

    const result = await runReconciliation('2026-03-14');

    expect(result.passed).toBe(false);
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error), expect.objectContaining({ tags: { job: 'reconciliation', type: 'controlling_identity_breach' } })
    );
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringContaining('RECONCILIATION DISCREPANCY DETECTED') }) })
    );
    expect(mockPrisma.reconciliationRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ passed: false }) });
  });

  it('alerts when an obligation has no matching disbursement or a recovery has no obligation', async () => {
    (dailyVerification as jest.Mock).mockResolvedValue(verification({ passed: false, obligationsWithoutDisbursement: [7], recoveriesWithoutObligation: [9] }));

    await runReconciliation('2026-03-14');

    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error), expect.objectContaining({ tags: { job: 'reconciliation', type: 'daily_verification_failed' } })
    );
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringMatching(/without a disbursement \[7\].*without an obligation \[9\]/) }) })
    );
  });

  it('classifies open obligations from their registered windows and flags status drift', async () => {
    mockPrisma.obligation.findMany.mockResolvedValue([
      openObligation(1, 'Current'), // correct
      openObligation(8, 'Current'), // should be Watch -> drift
      openObligation(30, 'Default'), // correct, Default is terminal
    ]);

    const result = await runReconciliation('2026-03-14');

    expect(result.countsByStatus).toEqual({ Current: 1, Watch: 1, Delayed: 0, Default: 1 });
    expect(result.overdueCount).toBe(2);
    expect(result.statusMismatches).toBe(1);
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('status drift'), expect.objectContaining({ level: 'warning' }));
  });

  it('rethrows and reports to Sentry when a query fails', async () => {
    const error = new Error('db down');
    (controllingIdentity as jest.Mock).mockRejectedValue(error);
    await expect(runReconciliation('2026-03-14')).rejects.toThrow('db down');
    expect(mockSentry.captureException).toHaveBeenCalledWith(error, { tags: { job: 'reconciliation' } });
  });
});
