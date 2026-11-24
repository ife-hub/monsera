/**
 * End-to-end ledger test against a REAL, migrated Postgres database, through
 * the actual route handlers (auth middleware included). Evidence for the
 * spec's acceptance criteria 1, 3, 4, 5, 6 and 7.
 *
 * Skipped unless TEST_DATABASE_URL is set. The database is TRUNCATED — never
 * point this at real data. Run with:
 *
 *   DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy
 *   TEST_DATABASE_URL=postgresql://… npx jest tests/integration --runInBand
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const suite = TEST_DB ? describe : describe.skip;

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = 'integration-secret';
  process.env.SCORING_ENGINE_URL = 'http://scoring.test';
  process.env.WALLET_A_ID = '1';
  process.env.WALLET_B_ID = '2';
  process.env.WALLET_C_ID = '3';
  delete process.env.OBLIGATION_TIERS_KOBO; // pilot tiers
}

jest.mock('@sentry/nextjs', () => ({ __esModule: true, captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('@/lib/queues', () => ({ __esModule: true, recoveryQueue: { add: jest.fn() }, vendMetricsQueue: { add: jest.fn() } }));

import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';

const DAY = 86_400_000;

suite('ledger lifecycle on a real database', () => {
  // Loaded lazily so DATABASE_URL is set before the Prisma client is created.
  let prisma: any;
  let debit: any, credit: any, suspensions: any;
  let runDailySweep: any, controllingIdentity: any, dailyVerification: any, monthlyChecks: any;
  let token: string;
  const windowStart = new Date(Date.now() - 60_000);

  const call = (handler: any, path: string, body: object, headers: Record<string, string> = {}) =>
    handler(new NextRequest(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    }));
  let keyCounter = 0;
  const advance = (meterToken: string, amount: number) =>
    call(debit, '/api/transactions/debit', { meterToken, amount, disco: 'Ikeja Electric' },
      { 'API-Key': 'agg-key', 'Idempotency-Key': `d-${++keyCounter}` });
  const repay = (meterToken: string, amountKobo: number) =>
    call(credit, '/api/transactions/credit', { meterToken, amountKobo, disco: 'Ikeja Electric' },
      { 'API-Key': 'agg-key', 'Idempotency-Key': `c-${++keyCounter}` });

  beforeAll(async () => {
    prisma = (await import('@/lib/prisma')).default;
    debit = (await import('@/app/api/transactions/debit/route')).POST;
    credit = (await import('@/app/api/transactions/credit/route')).POST;
    suspensions = (await import('@/app/api/obligations/suspensions/route')).POST;
    ({ runDailySweep } = await import('@/lib/jobs/daily-sweep'));
    ({ controllingIdentity, dailyVerification, monthlyChecks } = await import('@/lib/reconciliation'));

    const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t: any) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);

    const user = await prisma.user.create({ data: { email: 'agg@test', passwordHash: 'x', name: 'Agg', userType: 'AGGREGATOR', updatedAt: new Date() } });
    await prisma.aggregator.create({ data: { userId: user.id, name: 'Agg', mail: 'agg@test', status: 'active', outstanding: 0, apiKey: 'agg-key', lastInteraction: new Date() } });
    await prisma.discoAdmin.create({ data: { name: 'Ikeja Electric', mail: 'ie@test', status: 'active', apiKey: 'ie-key', balance: 0, outstanding: 0, lastInteraction: new Date() } });
    await prisma.wallet.createMany({ data: [{ id: 1, walletType: 'A', balance: 100000 }, { id: 2, walletType: 'B', balance: 0 }, { id: 3, walletType: 'C', balance: 0 }] });
    await prisma.walletTransaction.create({ data: { walletId: 1, type: 'opening-balance', amountKobo: 10_000_000, description: 'test float' } });
    await prisma.cohortMeter.createMany({ data: ['M-2K', 'M-4K', 'M-7K', 'M-TIER'].map((meterToken) => ({ meterToken })) });
    await prisma.customer.create({ data: { meterToken: 'M-4K', band: 'A', riskLevel: 'low', outstanding: 0, status: 'active', state: 'active', lastInteraction: new Date(), dateAdded: new Date() } });

    token = jwt.sign({ userId: user.id, email: 'agg@test', userType: 'AGGREGATOR' }, 'integration-secret');
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ eligible: true, approved_amount: 7000, score: 700, model_version: 'int-v1' }) }) as any;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('criterion 1: disburses each pilot tier with disbursed + service = obligation, and rejects other amounts', async () => {
    const results = await Promise.all([advance('M-2K', 2000), advance('M-4K', 4000), advance('M-7K', 7000)]);
    expect(results.map((r: Response) => r.status)).toEqual([201, 201, 201]);

    const obligations = await prisma.obligation.findMany({ orderBy: { obligationKobo: 'asc' } });
    expect(obligations.map((o: any) => [o.obligationKobo, o.disbursedKobo, o.serviceKobo, o.rateBps])).toEqual([
      [200000, 181818, 18182, 1000],
      [400000, 363636, 36364, 1000],
      [700000, 636363, 63637, 1000],
    ]);

    const off = await advance('M-TIER', 5000);
    expect(off.status).toBe(400);
  });

  it('§3.2: declines a meter outside the cohort without scoring, and logs the decision', async () => {
    (global.fetch as jest.Mock).mockClear();
    const res = await advance('NOT-IN-COHORT', 2000);
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe('Meter is not in the participating cohort');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('criterion 6: every decision, approved and declined, is logged with its feature vector', async () => {
    const decisions = await prisma.decisionLog.findMany({ orderBy: { id: 'asc' } });
    expect(decisions.map((d: any) => d.decision)).toEqual(['approved', 'approved', 'approved', 'declined']);
    for (const d of decisions) {
      expect(d).toMatchObject({ meterToken: expect.any(String), band: expect.any(String), parameterVersion: expect.any(String), requestedKobo: expect.any(Number) });
      expect(Object.keys(d.features).length).toBeGreaterThan(0);
    }
    const approved = decisions.filter((d: any) => d.decision === 'approved');
    expect(approved.every((d: any) => /^DBT-/.test(d.correlationId) && d.modelVersion === 'int-v1')).toBe(true);
    expect(decisions[3]).toMatchObject({ modelVersion: 'rule:cohort', declineReason: 'Meter is not in the participating cohort' });
  });

  it('criterion 5: registers §5.2 windows by band (Band A ₦4,000 -> 7/13/21; Band B ₦7,000 -> 20/39/45)', async () => {
    const days = (o: any, d: Date) => Math.round((d.getTime() - o.disbursementDate.getTime()) / DAY);
    const a4 = await prisma.obligation.findFirst({ where: { meterToken: 'M-4K' } });
    const b7 = await prisma.obligation.findFirst({ where: { meterToken: 'M-7K' } });
    expect([days(a4, a4.watchDate), days(a4, a4.delayedDate), days(a4, a4.defaultDate)]).toEqual([7, 13, 21]);
    expect([days(b7, b7.watchDate), days(b7, b7.delayedDate), days(b7, b7.defaultDate)]).toEqual([20, 39, 45]);
  });

  it('§3.6: only the disbursed value leaves Wallet A; Wallet B receives nothing at disbursement', async () => {
    const [a, b] = await Promise.all([prisma.wallet.findUnique({ where: { id: 1 } }), prisma.wallet.findUnique({ where: { id: 2 } })]);
    expect(Math.round(Number(a.balance) * 100)).toBe(10_000_000 - 181818 - 363636 - 636363);
    expect(Number(b.balance)).toBe(0);
  });

  it('§4: recovers FIFO with partial, full and surplus payments; 100% lands in Wallet B', async () => {
    expect((await repay('M-2K', 100000)).status).toBe(201); // partial
    expect((await repay('M-4K', 400000)).status).toBe(201); // exact
    const surplus = await (await repay('M-7K', 800000)).json(); // 100,000 surplus
    expect(surplus.data.summary).toMatchObject({ totalRecoveredKobo: 700000, surplusKobo: 100000, obligationsFullyDischarged: 1 });

    const b = await prisma.wallet.findUnique({ where: { id: 2 } });
    expect(Math.round(Number(b.balance) * 100)).toBe(100000 + 400000 + 700000);
    const partial = await prisma.obligation.findFirst({ where: { meterToken: 'M-2K' } });
    expect(partial).toMatchObject({ remainingKobo: 100000, status: 'Current' });
  });

  it('§5.3: records a dispute suspension and its end against the obligation', async () => {
    const start = await call(suspensions, '/api/obligations/suspensions', { action: 'start', reason: 'customer_dispute', meterToken: 'M-2K' });
    expect(start.status).toBe(403); // aggregators cannot suspend; DisCo or Monsera staff only

    const staff = await prisma.user.create({ data: { email: 'ops@test', passwordHash: 'x', name: 'Ops', userType: 'MONSERA_ADMIN', updatedAt: new Date() } });
    const staffToken = jwt.sign({ userId: staff.id, email: 'ops@test', userType: 'MONSERA_ADMIN' }, 'integration-secret');
    const asStaff = (body: object) => suspensions(new NextRequest('http://localhost/api/obligations/suspensions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${staffToken}` }, body: JSON.stringify(body),
    }));

    const began = await (await asStaff({ action: 'start', reason: 'customer_dispute', meterToken: 'M-2K' })).json();
    expect(began.data.affected).toBe(1);
    expect((await prisma.obligation.findFirst({ where: { meterToken: 'M-2K' } })).clockSuspended).toBe(true);

    const ended = await (await asStaff({ action: 'end', reason: 'customer_dispute', meterToken: 'M-2K' })).json();
    expect(ended.data.affected).toBe(1);
    const rows = await prisma.obligationSuspension.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].endedAt).not.toBeNull();
  });

  it('criterion 4: the sweep moves principal only, once', async () => {
    const first = await runDailySweep();
    const principal = Math.floor((100000 * 181818) / 200000) + 363636 + 636363;
    expect(first.sweptKobo).toBe(principal);
    expect((await runDailySweep()).sweptKobo).toBe(0); // idempotent

    const b = await prisma.wallet.findUnique({ where: { id: 2 } });
    const serviceRecovered = 1_200_000 - principal;
    expect(Math.round(Number(b.balance) * 100)).toBe(serviceRecovered); // commission stays in B
  });

  it('criterion 7: the controlling identity holds, daily verification passes, all four monthly checks pass', async () => {
    const identity = await controllingIdentity();
    expect(identity).toMatchObject({ holds: true, discrepancyKobo: 0 });
    expect(identity.commissionAccruedKobo).toBe(18182 + 36364 + 63637);

    const windowEnd = new Date(Date.now() + 60_000);
    const daily = await dailyVerification(windowStart, windowEnd);
    expect(daily).toMatchObject({ passed: true, obligationsCreated: 3, recoveriesSettled: 3 });

    const checks = await monthlyChecks(windowStart, windowEnd);
    for (const c of checks) expect({ check: c.check, passed: c.passed, differenceKobo: c.differenceKobo }).toEqual({ check: c.check, passed: true, differenceKobo: 0 });
    expect(checks.map((c: any) => c.check)).toEqual(['1 Wallet A', '2 Wallet B', '3 Obligation registry', '4 Service charge accrual', '4b Commission received into B']);
    expect((await controllingIdentity(windowEnd)).holds).toBe(true);
  });

  it('criterion 3: declines (HTTP 200) rather than overdrawing Wallet A, and Wallet A never goes negative', async () => {
    await prisma.cohortMeter.create({ data: { meterToken: 'M-BIG' } });
    await prisma.$executeRaw`UPDATE "Wallet" SET balance = 100 WHERE id = 1`; // ₦100 left (direct edit, for the test only)
    const res = await advance('M-BIG', 2000);
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toMatch(/Credit wallet exhausted/);
    expect(Number((await prisma.wallet.findUnique({ where: { id: 1 } })).balance)).toBe(100);
    const lastDecision = await prisma.decisionLog.findFirst({ orderBy: { id: 'desc' } });
    expect(lastDecision).toMatchObject({ meterToken: 'M-BIG', decision: 'declined' });
  });

  it('detects tampering: the wallet edit above breaks the identity; a registry edit breaks check 3', async () => {
    expect((await controllingIdentity()).holds).toBe(false); // balance no longer matches the ledger

    await prisma.$executeRaw`UPDATE "Obligation" SET "remainingKobo" = 0 WHERE "meterToken" = 'M-2K'`;
    const checks = await monthlyChecks(windowStart, new Date(Date.now() + 60_000));
    expect(checks.find((c: any) => c.check === '3 Obligation registry').passed).toBe(false);
  });

  it('§10: the audit trail is append-only at the database level', async () => {
    const attempts = [
      prisma.$executeRaw`UPDATE "WalletTransaction" SET "amountKobo" = 1`,
      prisma.$executeRaw`DELETE FROM "DecisionLog"`,
      prisma.$executeRaw`DELETE FROM "Audit"`,
      prisma.$executeRaw`UPDATE "ObligationRecovery" SET "amountKobo" = 1`,
      prisma.$executeRaw`UPDATE "ObligationRecovery" SET "sweptAt" = NULL`,
      prisma.$executeRaw`DELETE FROM "ObligationSuspension"`,
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toThrow(/append-only/);
  });
});
