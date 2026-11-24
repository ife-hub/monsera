/**
 * adjustWallet against a real Postgres: the guarantees the money path relies
 * on when many advances hit Wallet A at once.
 *
 * Skipped unless TEST_DATABASE_URL is set. The database is TRUNCATED — never
 * point this at real data.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const suite = TEST_DB ? describe : describe.skip;

if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

suite('adjustWallet on a real database', () => {
  let prisma: any;
  let adjustWallet: any, InsufficientWalletBalanceError: any;

  beforeAll(async () => {
    prisma = (await import('@/lib/prisma')).default;
    ({ adjustWallet, InsufficientWalletBalanceError } = await import('@/lib/wallets'));
  });

  beforeEach(async () => {
    const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t: any) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    // Wallet A holds exactly 10 debits of 1,000 kobo.
    await prisma.wallet.create({ data: { id: 1, walletType: 'A', balance: 100 } });
    await prisma.walletTransaction.create({ data: { walletId: 1, type: 'opening-balance', amountKobo: 10_000, description: 'test float' } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const ledgerSumKobo = async () =>
    Number((await prisma.walletTransaction.aggregate({ where: { walletId: 1 }, _sum: { amountKobo: true } }))._sum.amountKobo ?? 0);
  const balanceKobo = async () => Math.round(Number((await prisma.wallet.findUnique({ where: { id: 1 } })).balance) * 100);

  it('moves the balance and writes the ledger row in one step, returning both', async () => {
    const result = await prisma.$transaction((tx: any) => adjustWallet(tx, 1, -1_000, 'disbursement', 'one advance', 'DBT-1'));

    expect(result.previousBalanceKobo).toBe(10_000);
    expect(result.newBalanceKobo).toBe(9_000);
    expect(Number(result.wallet.balance)).toBe(90);
    expect(result.record).toMatchObject({ walletId: 1, type: 'disbursement', amountKobo: -1_000, description: 'one advance', referenceId: 'DBT-1' });
    expect(await balanceKobo()).toBe(9_000);
    expect(await ledgerSumKobo()).toBe(9_000);
  });

  it('50 concurrent debits against a balance for 10: exactly 10 succeed and the balance never goes negative', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        prisma.$transaction((tx: any) => adjustWallet(tx, 1, -1_000, 'disbursement', `advance ${i}`, `DBT-${i}`), { maxWait: 20_000, timeout: 30_000 })
      )
    );

    const ok = attempts.filter((a) => a.status === 'fulfilled').length;
    const refused = attempts.filter((a) => a.status === 'rejected' && (a as PromiseRejectedResult).reason instanceof InsufficientWalletBalanceError).length;
    expect(ok).toBe(10);
    expect(refused).toBe(40);
    expect(await balanceKobo()).toBe(0);
    // Balance = sum of its ledger rows, and no ledger row without its balance move.
    expect(await ledgerSumKobo()).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { type: 'disbursement' } })).toBe(10);
  });

  it('a refused debit changes nothing and reports the balance it saw', async () => {
    const error = await prisma
      .$transaction((tx: any) => adjustWallet(tx, 1, -20_000, 'disbursement', 'too big'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InsufficientWalletBalanceError);
    expect(error.balanceKobo).toBe(10_000);
    expect(error.requestedKobo).toBe(20_000);
    expect(await balanceKobo()).toBe(10_000);
    expect(await prisma.walletTransaction.count()).toBe(1); // only the opening balance
  });

  it('the move rolls back with the surrounding transaction', async () => {
    await prisma
      .$transaction(async (tx: any) => {
        await adjustWallet(tx, 1, -1_000, 'disbursement', 'rolled back');
        throw new Error('later step failed');
      })
      .catch(() => undefined);

    expect(await balanceKobo()).toBe(10_000);
    expect(await prisma.walletTransaction.count()).toBe(1);
  });

  it('credits always succeed, and an unknown wallet is an error, not a silent no-op', async () => {
    await prisma.$transaction((tx: any) => adjustWallet(tx, 1, 5_000, 'top-up', 'more float'));
    expect(await balanceKobo()).toBe(15_000);

    await expect(prisma.$transaction((tx: any) => adjustWallet(tx, 99, -1, 'disbursement', 'nowhere'))).rejects.toThrow('Wallet 99 not found');
  });
});
