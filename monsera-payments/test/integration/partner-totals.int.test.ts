export {}; // a module, so its top-level names stay its own
/**
 * Disco/aggregator running totals as pending changes, against a real
 * Postgres (lib/partner-totals.ts).
 *
 * Skipped unless TEST_DATABASE_URL is set. The database is TRUNCATED — never
 * point this at real data.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const suite = TEST_DB ? describe : describe.skip;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

suite('partner totals on a real database', () => {
  jest.setTimeout(60_000);
  let prisma: any;
  let pt: typeof import('@/lib/partner-totals');

  beforeAll(async () => {
    prisma = (await import('@/lib/prisma')).default;
    pt = await import('@/lib/partner-totals');
  });

  beforeEach(async () => {
    const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t: any) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    await prisma.discoAdmin.create({ data: { id: 1, name: 'APLE', mail: 'aple@test', status: 'active', balance: 1000, outstanding: 0, lastInteraction: new Date('2026-01-01') } });
    await prisma.aggregator.create({ data: { id: 1, name: 'Agg', mail: 'agg@test', status: 'active', outstanding: 0, lastInteraction: new Date('2026-01-01') } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const disco = async () => prisma.discoAdmin.findUnique({ where: { id: 1 } });
  const kobo = (d: any) => Math.round(Number(d) * 100);

  it('100 concurrent advances record their changes without waiting on the disco row; folding gives exact totals', async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        prisma.$transaction((tx: any) =>
          pt.recordPartnerChanges(tx, [
            { partnerType: 'disco', partnerId: 1, balanceDeltaKobo: -1_000, outstandingDeltaKobo: 1_000, reference: `DBT-${i}` },
            { partnerType: 'aggregator', partnerId: 1, outstandingDeltaKobo: 1_000, reference: `DBT-${i}` },
          ])
        )
      )
    );

    // Before folding: the row is unchanged, but the exact current figure includes the pending changes.
    expect(kobo((await disco()).balance)).toBe(100_000);
    expect(await pt.partnerTotals('disco', 1)).toEqual({ balanceKobo: 0, outstandingKobo: 100_000 });

    const folded = await pt.foldAllPartnerChanges();
    expect(folded).toBe(200);
    const d = await disco();
    expect([kobo(d.balance), kobo(d.outstanding)]).toEqual([0, 100_000]);
    expect(kobo((await prisma.aggregator.findUnique({ where: { id: 1 } })).outstanding)).toBe(100_000);
    expect(d.lastInteraction.getTime()).toBeGreaterThan(new Date('2026-01-01').getTime());
    expect(await pt.partnerTotals('disco', 1)).toEqual({ balanceKobo: 0, outstandingKobo: 100_000 });
    expect(await prisma.partnerBalanceChange.count({ where: { appliedAt: null } })).toBe(0);
  });

  it('several instances folding at once apply every change exactly once', async () => {
    for (let i = 0; i < 300; i++) {
      await prisma.partnerBalanceChange.create({ data: { partnerType: 'disco', partnerId: 1, balanceDeltaKobo: -100, outstandingDeltaKobo: 100, interactionAt: new Date() } });
    }
    // Small batches so the folds really interleave.
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let r = 0; r < 20; r++) await pt.foldPartnerChanges(25);
    }));
    await pt.foldAllPartnerChanges();

    const d = await disco();
    expect([kobo(d.balance), kobo(d.outstanding)]).toEqual([100_000 - 30_000, 30_000]);
    expect(await prisma.partnerBalanceChange.count({ where: { appliedAt: null } })).toBe(0);
  });

  it('a change rolled back with its transaction never reaches the totals', async () => {
    await prisma
      .$transaction(async (tx: any) => {
        await pt.recordPartnerChanges(tx, [{ partnerType: 'disco', partnerId: 1, balanceDeltaKobo: -5_000, outstandingDeltaKobo: 5_000 }]);
        throw new Error('advance failed later');
      })
      .catch(() => undefined);
    await pt.foldAllPartnerChanges();
    expect(kobo((await disco()).balance)).toBe(100_000);
  });
});
