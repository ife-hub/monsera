export {}; // a module, so its top-level names stay its own
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

suite('Wallet A sub-wallets on a real database', () => {
  jest.setTimeout(60_000);
  let prisma: any;
  let walletA: typeof import('@/lib/wallet-a');
  let InsufficientWalletBalanceError: any;

  beforeAll(async () => {
    prisma = (await import('@/lib/prisma')).default;
    walletA = await import('@/lib/wallet-a');
    ({ InsufficientWalletBalanceError } = await import('@/lib/wallets'));
  });

  beforeEach(async () => {
    const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t: any) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    Object.assign(process.env, { WALLET_A_ID: '1', WALLET_B_ID: '2', WALLET_C_ID: '3', WALLET_A_SHARDS: '8' });
    // Wallet A, B and C seeded with explicit ids (as the seed scripts do), which leaves the id sequence behind.
    await prisma.wallet.createMany({ data: [{ id: 1, walletType: 'A', balance: 100 }, { id: 2, walletType: 'B', balance: 0 }, { id: 3, walletType: 'C', balance: 0 }] });
    await prisma.walletTransaction.create({ data: { walletId: 1, type: 'opening-balance', amountKobo: 10_000, description: 'test float' } });
  });

  afterAll(async () => {
    delete process.env.WALLET_A_SHARDS;
    await prisma?.$disconnect();
  });

  /** Every Wallet A row's balance equals its own ledger. */
  const rowsMatchTheirLedgers = async () => {
    const rows = await prisma.$queryRaw`
      SELECT w.id, ROUND(COALESCE(w.balance, 0) * 100) AS balance, COALESCE(SUM(t."amountKobo"), 0) AS ledger
        FROM "Wallet" w LEFT JOIN "WalletTransaction" t ON t."walletId" = w.id
       WHERE w.id = 1 OR w."parentWalletId" = 1 GROUP BY w.id`;
    return rows.every((r: any) => Number(r.balance) === Number(r.ledger));
  };

  it('creates the sub-wallets once, even when several instances start together', async () => {
    const results = await Promise.all([walletA.ensureWalletASubWallets(), walletA.ensureWalletASubWallets(), walletA.ensureWalletASubWallets()]);
    expect(results[0]).toHaveLength(8);
    expect(await prisma.wallet.count({ where: { parentWalletId: 1 } })).toBe(7);
  });

  it('never gives a sub-wallet an id that Wallet B or C is configured to use', async () => {
    // Wallet C's row does not exist yet, but WALLET_C_ID points at 9.
    process.env.WALLET_C_ID = '9';
    await prisma.wallet.delete({ where: { id: 3 } });
    const ids = await walletA.ensureWalletASubWallets();
    process.env.WALLET_C_ID = '3';
    expect(ids.filter((id) => id !== 1).every((id) => id > 9)).toBe(true);
  });

  it('spreads the money evenly without changing the total, recording net-zero rebalance rows', async () => {
    await walletA.ensureWalletASubWallets();
    await walletA.rebalanceWalletA();

    const rows = await prisma.wallet.findMany({ where: { OR: [{ id: 1 }, { parentWalletId: 1 }] }, orderBy: { id: 'asc' } });
    expect(rows.map((r: any) => Math.round(Number(r.balance) * 100))).toEqual([1250, 1250, 1250, 1250, 1250, 1250, 1250, 1250]);
    expect(await walletA.walletABalanceKobo()).toBe(10_000);
    const rebalance = await prisma.walletTransaction.aggregate({ where: { type: 'rebalance' }, _sum: { amountKobo: true } });
    expect(Number(rebalance._sum.amountKobo)).toBe(0);
    expect(await rowsMatchTheirLedgers()).toBe(true);
  });

  it('50 concurrent advances against Wallet A holding 10: exactly 10 succeed, gathering money that is spread too thin', async () => {
    await walletA.ensureWalletASubWallets();
    await walletA.rebalanceWalletA(); // 1,250 kobo per row: after one debit each, no row can cover another on its own

    const attempts = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        prisma.$transaction((tx: any) => walletA.debitWalletA(tx, 1_000, 'disbursement', `advance ${i}`, `DBT-${i}`), { maxWait: 20_000, timeout: 30_000 })
      )
    );

    const unexpected = attempts.filter((a) => a.status === 'rejected' && !((a as PromiseRejectedResult).reason instanceof InsufficientWalletBalanceError));
    expect(unexpected.map((a) => String((a as PromiseRejectedResult).reason?.message ?? (a as PromiseRejectedResult).reason).slice(0, 400))).toEqual([]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(10);
    expect(attempts.filter((a) => a.status === 'rejected' && (a as PromiseRejectedResult).reason instanceof InsufficientWalletBalanceError)).toHaveLength(40);
    expect(await walletA.walletABalanceKobo()).toBe(0);
    expect(await prisma.wallet.count({ where: { OR: [{ id: 1 }, { parentWalletId: 1 }], balance: { lt: 0 } } })).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { type: 'disbursement' } })).toBe(10);
    expect(await rowsMatchTheirLedgers()).toBe(true);
  });

  it('advances run in parallel on different sub-wallets instead of queueing on one row', async () => {
    await walletA.ensureWalletASubWallets();
    await walletA.rebalanceWalletA();

    // Hold two transactions open at once, each having taken from Wallet A: with
    // a single row the second would wait for the first to commit.
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const used: number[] = [];
    const first = prisma.$transaction(async (tx: any) => {
      used.push((await walletA.debitWalletA(tx, 100, 'disbursement', 'held')).walletId);
      await hold;
    }, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    const second = await prisma.$transaction((tx: any) => walletA.debitWalletA(tx, 100, 'disbursement', 'not blocked'), { timeout: 10_000 });
    used.push(second.walletId);
    release();
    await first;
    expect(new Set(used).size).toBe(2);
  });

  it('refuses when Wallet A in total cannot cover it, and changes nothing', async () => {
    await walletA.ensureWalletASubWallets();
    await walletA.rebalanceWalletA();

    const error = await prisma.$transaction((tx: any) => walletA.debitWalletA(tx, 20_000, 'disbursement', 'too big')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientWalletBalanceError);
    expect(error.balanceKobo).toBe(10_000);
    expect(await walletA.walletABalanceKobo()).toBe(10_000);
    expect(await prisma.walletTransaction.count({ where: { type: 'disbursement' } })).toBe(0);
  });

  it('reconciliation treats all the rows as Wallet A', async () => {
    await walletA.ensureWalletASubWallets();
    await walletA.rebalanceWalletA();
    const { controllingIdentity } = await import('@/lib/reconciliation');
    const identity = await controllingIdentity();
    expect(identity.walletAKobo).toBe(10_000);
    expect(identity.floatDeployedKobo).toBe(10_000);
    expect(identity.holds).toBe(true);
  });
});
