jest.mock('@sentry/nextjs', () => ({ __esModule: true, captureException: jest.fn() }));
// The post-sweep spread over Wallet A's sub-wallets is covered by the real-database tests.
jest.mock('@/lib/wallet-a', () => ({ __esModule: true, rebalanceWalletAQuietly: jest.fn() }));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    walletTransaction: { create: jest.fn() },
    obligationRecovery: { findMany: jest.fn(), updateMany: jest.fn() },
    wallet: { update: jest.fn() },
    audit: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));

import * as Sentry from '@sentry/nextjs';
import prisma from '@/lib/prisma';
import { runDailySweep } from '@/lib/jobs/daily-sweep';
import { isAdjustWalletSql, fakeAdjustWallet } from '../../helpers/wallet-sql';

const mockPrisma = prisma as any;
const mockSentry = Sentry as unknown as { captureException: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WALLET_A_ID = '1';
  process.env.WALLET_B_ID = '2';
  mockPrisma.audit.create.mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
  // Wallet B holds plenty of recovered cash; adjustWallet's single statement
  // is answered by the shared fake (test/helpers/wallet-sql.ts).
  const balances: Record<number, number> = { 1: 0, 2: 1_000_000 };
  mockPrisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
    isAdjustWalletSql(strings) ? fakeAdjustWallet(mockPrisma, balances, values) : [{ balance: balances[2] }]
  );
  mockPrisma.wallet.update.mockResolvedValue({});
  mockPrisma.walletTransaction.create.mockResolvedValue({ id: 1 });
  mockPrisma.obligationRecovery.updateMany.mockImplementation(async ({ where }: any) => ({ count: where.id.in.length }));
});

describe('runDailySweep', () => {
  it('logs and returns zero when there are no unswept recoveries', async () => {
    mockPrisma.obligationRecovery.findMany.mockResolvedValue([]);
    const result = await runDailySweep();

    expect(result).toMatchObject({ sweptKobo: 0, obligationCount: 0 });
    expect(mockPrisma.obligationRecovery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sweptAt: null } })
    );
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringContaining('no unswept recoveries') }) })
    );
  });

  it('stamps recoveries but moves no money when total principal is zero', async () => {
    mockPrisma.obligationRecovery.findMany.mockResolvedValue([{ id: 1, principalKobo: 0 }]);

    const result = await runDailySweep();
    expect(result).toMatchObject({ sweptKobo: 0, obligationCount: 1 });
    expect(mockPrisma.obligationRecovery.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });

  it('moves the summed principal from Wallet B to Wallet A and stamps the recoveries', async () => {
    mockPrisma.obligationRecovery.findMany.mockResolvedValue([
      { id: 1, principalKobo: 1000, obligationId: 11 },
      { id: 2, principalKobo: 2000, obligationId: 10 },
    ]);

    const result = await runDailySweep();

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.obligationRecovery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1, 2] }, sweptAt: null } })
    );
    expect(mockPrisma.wallet.update).toHaveBeenCalledTimes(2);
    const ledgerRows = mockPrisma.walletTransaction.create.mock.calls.map((c: any) => c[0].data);
    expect(ledgerRows).toEqual([
      expect.objectContaining({ walletId: 2, type: 'sweep', amountKobo: -3000 }),
      expect.objectContaining({ walletId: 1, type: 'sweep', amountKobo: 3000 }),
    ]);
    expect(result).toEqual({ sweptKobo: 3000, obligationCount: 2, obligationIds: [10, 11] });
    // §7.1: the audit line names the obligations the movement relates to.
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringContaining('Obligations: [10, 11]') }) })
    );
  });

  it('is idempotent: a second run finds nothing left to sweep', async () => {
    mockPrisma.obligationRecovery.findMany
      .mockResolvedValueOnce([{ id: 1, principalKobo: 1000 }])
      .mockResolvedValueOnce([]);

    await runDailySweep();
    const second = await runDailySweep();

    expect(second).toMatchObject({ sweptKobo: 0, obligationCount: 0 });
    expect(mockPrisma.wallet.update).toHaveBeenCalledTimes(2); // only from the first run
  });

  it('aborts if another sweep stamped the same recoveries concurrently', async () => {
    mockPrisma.obligationRecovery.findMany.mockResolvedValue([{ id: 1, principalKobo: 1000 }]);
    mockPrisma.obligationRecovery.updateMany.mockResolvedValue({ count: 0 });

    await expect(runDailySweep()).rejects.toThrow('Sweep race');
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });

  it('writes a CRITICAL alert and rethrows when the sweep fails', async () => {
    const error = new Error('lock timeout');
    mockPrisma.$queryRaw.mockRejectedValue(error);

    await expect(runDailySweep()).rejects.toThrow('lock timeout');
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      error, expect.objectContaining({ tags: { job: 'daily-sweep' } })
    );
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringContaining('CRITICAL ALERT: Daily sweep FAILED') }) })
    );
  });
});
