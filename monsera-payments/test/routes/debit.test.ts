import { Prisma } from '@prisma/client';
import { isEnabled } from '@/lib/feature-flags';
const mockIsEnabled = isEnabled as jest.Mock;

jest.mock('@/lib/feature-flags', () => ({
  __esModule: true,
  isEnabled: jest.fn(),
}));

jest.mock('@/middleware/auth', () => ({
  __esModule: true,
  authorize: () => (handler: any) => handler,
}));

jest.mock('@sentry/nextjs', () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/idempotency', () => ({
  __esModule: true,
  checkIdempotency: jest.fn(),
  saveIdempotencyRecordTx: jest.fn(),
}));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    aggregator: { findUnique: jest.fn() },
    discoAdmin: { findUnique: jest.fn() },
    customer: { findUnique: jest.fn() },
    decisionLog: { create: jest.fn(), update: jest.fn() },
    burnRate: { findFirst: jest.fn(), findMany: jest.fn() },
    cohortMeter: { findUnique: jest.fn() },
    recoveryWindowParameters: { findFirst: jest.fn() },
    audit: { create: jest.fn() },
    transactions: { findMany: jest.fn() },
    creditParameters: { findFirst: jest.fn() },
    customerVendMetrics: { findUnique: jest.fn() },
    obligation: { count: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import prisma from '@/lib/prisma';
import * as Sentry from '@sentry/nextjs';
import { checkIdempotency, saveIdempotencyRecordTx } from '@/lib/idempotency';
import { POST as debitPost } from '@/app/api/transactions/debit/route';
import { isAdjustWalletSql, fakeAdjustWallet, isDebitWalletASql, fakeDebitWalletA, isWalletATotalSql, walletATotalRows } from '../helpers/wallet-sql';

const mockPrisma = prisma as any;
const mockCheckIdempotency = checkIdempotency as jest.Mock;
const mockSaveIdempotencyRecordTx = saveIdempotencyRecordTx as jest.Mock;
const mockSentry = Sentry as unknown as { captureException: jest.Mock };

const CORS_ORIGIN = 'https://app.plugmonsera.com';

function makeRequest({
  body,
  user = { userId: 1, userType: 'AGGREGATOR', email: 'agg@example.com' },
  headers = {},
}: {
  body: object;
  user?: any;
  headers?: Record<string, string>;
}): any {
  const headerMap = new Map(Object.entries({ origin: CORS_ORIGIN, ...headers }));
  return {
    json: async () => body,
    headers: { get: (key: string) => headerMap.get(key.toLowerCase()) ?? headerMap.get(key) ?? null },
    user,
  };
}

/** The SQL text of a tagged-template $executeRaw / $queryRaw call. */
const sqlOf = (call: any[]) => (call[0] as TemplateStringsArray).join('?');

/** All INSERT ... "Customers" statements the transaction issued. */
const customerInserts = (tx: any) =>
  tx.$executeRaw.mock.calls.filter((c: any[]) => /INSERT INTO "Customers"/.test(sqlOf(c)));

function makeTxMock(overrides: Record<string, any> = {}, { walletBalanceNaira = 10_000_000 } = {}) {
  const walletA = { id: 1, balance: walletBalanceNaira }; // naira
  const discoAdmin = { id: 10, name: 'IKEDC', status: 'active', apiKey: 'valid-key', balance: 500000, outstanding: 0 };
  const customer = { id: 100, meterToken: 'MT-001', outstanding: 0, band: 'B', status: 'active' };

  const balances: Record<number, number> = { 1: walletA.balance };
  // Read outside the transaction: Wallet A's total, and the disco's current
  // totals (its row, 500000 naira, plus the change this advance recorded).
  mockPrisma.$queryRaw = jest.fn(async (strings: TemplateStringsArray) => {
    if (isWalletATotalSql(strings)) return walletATotalRows(balances);
    if (strings.join('?').includes('"PartnerBalanceChange"')) {
      const recorded = tx.partnerBalanceChange.createMany.mock.calls.flatMap((c: any) => c[0].data).filter((r: any) => r.partnerType === 'disco');
      const delta = recorded.reduce((sum: number, r: any) => sum + r.balanceDeltaKobo, 0);
      return [{ balance: 50_000_000 + delta, outstanding: 0 }];
    }
    return [];
  });
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: jest.fn().mockResolvedValue(undefined), // savepoints around Wallet A attempts
    partnerBalanceChange: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    // Row locks: lockWallet reads the locked Wallet A balance; the debit
    // handler then locks the customer row by meterToken.
    $queryRaw: jest.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (isAdjustWalletSql(strings)) return fakeAdjustWallet(tx, balances, values);
      if (isDebitWalletASql(strings)) return fakeDebitWalletA(tx, balances, values);
      if (isWalletATotalSql(strings)) return walletATotalRows(balances);
      if (sql.includes('"Wallet"')) return [{ balance: balances[1] }];
      if (sql.includes('"Customers"')) return [{ id: customer.id }];
      return [];
    }),
    discoAdmin: { findUnique: jest.fn().mockResolvedValue(discoAdmin), update: jest.fn().mockResolvedValue({ ...discoAdmin, balance: 490000, outstanding: 10000 }) },
    wallet: { findUnique: jest.fn().mockResolvedValue(walletA), update: jest.fn().mockResolvedValue({}) },
    customer: {
      create: jest.fn().mockResolvedValue(customer),
      findUniqueOrThrow: jest.fn().mockResolvedValue(customer),
      update: jest.fn().mockResolvedValue({ ...customer, outstanding: 550000 }),
    },
    walletTransaction: { create: jest.fn().mockResolvedValue({}) },
    aggregator: { update: jest.fn().mockResolvedValue({ id: 1, outstanding: 500000 }) },
    transactions: { create: jest.fn().mockResolvedValue({ id: 1, transactionId: 'DBT-1', amount: 5000 }) },
    obligation: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({
        id: 1,
        status: 'Current',
        obligationKobo: 550000,
        disbursedKobo: 500000,
        serviceKobo: 50000,
        remainingKobo: 550000,
        expectedRecoveryDate: new Date('2026-02-01'),
      }),
    },
    decisionLog: { create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    audit: { create: jest.fn().mockResolvedValue({}) },
    ...overrides,
  };
  return tx;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockImplementation(async (flag: string) => flag !== 'maintenance_mode');
  process.env.WALLET_A_ID = '1';
  process.env.RATE_BPS = '1000';
  process.env.MIN_OBLIGATION_KOBO = '200000';
  process.env.MAX_OBLIGATION_KOBO = '700000';
  process.env.SCORING_ENGINE_URL = 'https://scoring.internal';
  process.env.SCORING_ENGINE_SECRET = 'secret';
  process.env.LOW_WALLET_A_BALANCE_KOBO = '5000000';

  mockCheckIdempotency.mockResolvedValue(null); // no replay by default
  mockPrisma.aggregator.findUnique.mockResolvedValue({ id: 1, apiKey: 'valid-key', status: 'active' });
  mockPrisma.discoAdmin.findUnique.mockResolvedValue({ id: 10, name: 'IKEDC', apiKey: 'disco-key', status: 'active' });
  mockPrisma.customer.findUnique.mockResolvedValue(null); // new customer by default
  mockPrisma.decisionLog.create.mockResolvedValue({});
  mockPrisma.burnRate.findFirst.mockResolvedValue({ dailyBurnNaira: 650 });
  mockPrisma.burnRate.findMany.mockResolvedValue([]); // §5.1 per-band defaults apply
  mockPrisma.cohortMeter.findUnique.mockResolvedValue({ removedAt: null }); // in the cohort
  mockPrisma.recoveryWindowParameters.findFirst.mockResolvedValue(null); // §5.2 as written
  // Most tests below use ₦5,000 for its round numbers; the pilot's fixed
  // tiers are exercised in 'fixed obligation tiers' at the end.
  process.env.OBLIGATION_TIERS_KOBO = '';
  mockPrisma.transactions.findMany.mockResolvedValue([]);
  mockPrisma.creditParameters.findFirst.mockResolvedValue(null); // fall back to env parameters
  mockPrisma.customerVendMetrics.findUnique.mockResolvedValue(null);
  mockPrisma.obligation.count.mockResolvedValue(0);

  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ eligible: true, approved_amount: 5500, score: 720, band: 'B', model_version: 'v1' }),
  }) as any;
});

afterEach(() => {
  delete (global as any).fetch;
});

describe('debit route — request validation', () => {
  it('returns 400 when meterToken is missing', async () => {
    const req = makeRequest({ body: { amount: 5000, disco: 'IKEDC' } });
    const res = await debitPost(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is missing', async () => {
    const req = makeRequest({ body: { meterToken: 'MT-001', disco: 'IKEDC' } });
    const res = await debitPost(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is zero or negative', async () => {
    const req = makeRequest({ body: { meterToken: 'MT-001', amount: 0, disco: 'IKEDC' } });
    const res = await debitPost(req);
    expect(res.status).toBe(400);
  });

  it('returns 403 for a userType that is neither AGGREGATOR nor DISCO_ADMIN', async () => {
    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      user: { userId: 1, userType: 'EMPLOYEE' },
    });
    const res = await debitPost(req);
    expect(res.status).toBe(403);
  });
});

describe('debit route — feature flags', () => {
  it('declines with HTTP 200 when disbursements_enabled is false', async () => {
    mockIsEnabled.mockImplementation(async (flag: string) => flag !== 'disbursements_enabled' && flag !== 'maintenance_mode');
    const req = makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key' } });
    const res = await debitPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe('declined');
    expect(body.reason).toMatch(/temporarily suspended/i);
  });

  it('returns 503 when maintenance_mode is true', async () => {
  mockIsEnabled.mockImplementation(async (flag: string) => {
    if (flag === 'disbursements_enabled') return true;
    if (flag === 'maintenance_mode') return true;
    return true;
  });
  const req = makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key' } });
  const res = await debitPost(req);
  expect(res.status).toBe(503);
});

it('declines with HTTP 200 when scoring_engine_enabled is false, without calling fetch', async () => {
  mockIsEnabled.mockImplementation(async (flag: string) => {
    if (flag === 'maintenance_mode') return false;
    if (flag === 'scoring_engine_enabled') return false;
    return true; // disbursements_enabled stays on
  });
  const req = makeRequest({
    body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
    headers: { 'API-Key': 'valid-key' },
  });
  const res = await debitPost(req);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.decision).toBe('declined');
  expect(global.fetch).not.toHaveBeenCalled();
});

  it('logs the decline as a decision (§6.1) and never scores when disbursements are suspended', async () => {
    mockIsEnabled.mockImplementation(async (flag: string) => flag !== 'disbursements_enabled' && flag !== 'maintenance_mode');
    const req = makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key' } });
    await debitPost(req);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPrisma.decisionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ decision: 'declined', modelVersion: 'rule:disbursements_suspended' }),
    }));
  });

  it('does not reveal the suspension to a caller with an invalid API key', async () => {
    mockIsEnabled.mockImplementation(async (flag: string) => flag !== 'disbursements_enabled' && flag !== 'maintenance_mode');
    const req = makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' }, headers: { 'API-Key': 'wrong' } });
    expect((await debitPost(req)).status).toBe(403);
  });
});

describe('debit route — account lookups', () => {
  it('returns 404 when the aggregator account cannot be found', async () => {
    mockPrisma.aggregator.findUnique.mockResolvedValue(null);
    const req = makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' } });
    const res = await debitPost(req);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the disco cannot be found', async () => {
    mockPrisma.discoAdmin.findUnique.mockResolvedValue(null);
    const req = makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'UNKNOWN' } });
    const res = await debitPost(req);
    expect(res.status).toBe(404);
  });
});

describe('debit route — idempotency, auth headers, account status', () => {
  it('short-circuits with the cached response when checkIdempotency finds a replay', async () => {
    const cached = new Response(JSON.stringify({ success: true, cached: true }), { status: 201 });
    mockCheckIdempotency.mockResolvedValue(cached);

    const req = makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' } });
    const res = await debitPost(req);

    expect(res).toBe(cached);
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled(); // never reached business logic
  });

  it('returns 401 when the API-Key header is missing', async () => {
    const req = makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' } });
    const res = await debitPost(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the API-Key does not match the caller', async () => {
    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'wrong-key' },
    });
    const res = await debitPost(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller account is not active', async () => {
    mockPrisma.aggregator.findUnique.mockResolvedValue({ id: 1, apiKey: 'valid-key', status: 'suspended' });
    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await debitPost(req);
    expect(res.status).toBe(403);
  });
});

describe('debit route — calculation validation', () => {
  it('returns 400 when the obligation amount is below MIN_OBLIGATION_KOBO', async () => {
    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 10, disco: 'IKEDC' }, // 1000 kobo, below 200000 min
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await debitPost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/below minimum/i);
  });

  it('returns 400 when the obligation amount is above MAX_OBLIGATION_KOBO', async () => {
    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 100000, disco: 'IKEDC' }, // way above max
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await debitPost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/exceeds maximum/i);
  });
});

describe('debit route — scoring engine outcomes', () => {
  it('declines with HTTP 200 and logs a decision when the scoring engine call fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network error'));
    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });

    const res = await debitPost(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe('declined');
    expect(mockPrisma.decisionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: 'declined', declineReason: expect.stringContaining('Scoring engine error') }) })
    );
  });

  it('declines with HTTP 200 when the scoring engine returns a non-OK status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503 });
    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await debitPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe('declined');
  });

  it('declines with HTTP 200 when the scoring engine marks the customer ineligible', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ eligible: false, reason: 'Too many failed vends', score: 300, band: 'C' }),
    });
    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await debitPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe('declined');
    expect(body.reason).toBe('Too many failed vends');
  });

  it('declines with HTTP 200 when the approved amount is less than the requested obligation', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ eligible: true, approved_amount: 3000, score: 600, band: 'B' }), // less than 5500 requested
    });
    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await debitPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe('declined');
    expect(body.reason).toMatch(/exceeds approved limit/i);
  });
});

describe('debit route — wallet balance guard', () => {
  it('declines with HTTP 200 when Wallet A has insufficient balance inside the transaction', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = makeTxMock({}, { walletBalanceNaira: 1 }); // ₦1 in Wallet A (read under row lock)
      return cb(tx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await debitPost(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe('declined');
    expect(body.reason).toMatch(/exhausted/i);
  });
});

describe('debit route — happy path', () => {
  it('records the disco and aggregator total changes instead of updating their rows, and returns the disco\'s current balance', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock();
      return cb(capturedTx);
    });

    const res = await debitPost(makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'idem-partner-totals' },
    }));

    expect(res.status).toBe(201);
    const changes = capturedTx.partnerBalanceChange.createMany.mock.calls.flatMap((c: any) => c[0].data);
    expect(changes).toEqual([
      expect.objectContaining({ partnerType: 'disco', partnerId: 10, balanceDeltaKobo: -454545, outstandingDeltaKobo: 454545 }),
      expect.objectContaining({ partnerType: 'aggregator', outstandingDeltaKobo: 454545, balanceDeltaKobo: 0 }),
    ]);
    // No advance waits on the partner rows any more.
    expect(capturedTx.discoAdmin.update).not.toHaveBeenCalled();
    expect(capturedTx.aggregator.update).not.toHaveBeenCalled();
    // The response's disco balance = its row (₦500,000) + changes not yet folded in.
    const body = await res.json();
    expect(body.data.disco.newBalance).toBeCloseTo(500000 - 4545.45, 2);
  });

  it('approves, runs the transaction, writes the idempotency record inside it, and returns 201', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock();
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'idem-key-1' },
    });

    const res = await debitPost(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.decision).toBe('approved');
    expect(body.data.calculation.obligationKobo).toBe(500000);
    expect(body.data.calculation.disbursedKobo).toBe(454545);
    expect(body.data.calculation.serviceKobo).toBe(45455);

    // idempotency written inside the same tx, not after commit
    expect(mockSaveIdempotencyRecordTx).toHaveBeenCalledWith(
      capturedTx,
      'idem-key-1',
      1, // aggregator id
      'aggregator',
      201,
      expect.any(Object)
    );
    expect(customerInserts(capturedTx)).toHaveLength(1); // new customer path (race-safe insert)
  });

  it('updates the existing customer rather than creating one when the meter token is already known', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue({ id: 5, meterToken: 'MT-001', band: 'B', outstanding: 0, status: 'active' });

    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock();
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'idem-key-2' },
    });
    await debitPost(req);

    expect(customerInserts(capturedTx)).toHaveLength(0);
    expect(capturedTx.customer.update).toHaveBeenCalled();
  });

  it('writes a low-balance alert audit line when the post-disbursement Wallet A balance drops below threshold', async () => {
    process.env.LOW_WALLET_A_BALANCE_KOBO = '9600000'; // between 10,000,000 and 9,545,455

    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        capturedTx = makeTxMock({}, { walletBalanceNaira: 100000 }); // ₦100,000 in Wallet A (read under row lock)
        return cb(capturedTx);
    });

    const req = makeRequest({
        body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
        headers: { 'API-Key': 'valid-key' },
    });
    await debitPost(req);

    // §7.2: written after commit and raised to Sentry, not just logged.
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringContaining('ALERT: Wallet A balance low') }) })
    );
    expect((Sentry as any).captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('Wallet A balance low'), expect.objectContaining({ level: 'warning' })
    );
    });
});

describe('debit route — the idempotency-conflict regression (current, un-fixed behavior)', () => {
  it('returns a generic 500 — NOT a 409 replay — when the transaction rolls back on a unique-constraint race', async () => {
    // This pins down CURRENT behavior. isIdempotencyKeyConflict/resolveIdempotencyConflict
    // are no longer wired into this route's catch block, so a losing concurrent request
    // surfaces as a plain 500 instead of a friendly conflict/replay response.
    const conflictError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`key`)', {
      code: 'P2002',
      clientVersion: '6.19.0',
    });
    mockPrisma.$transaction.mockRejectedValue(conflictError);

    const req = makeRequest({
      body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'racing-key' },
    });
    const res = await debitPost(req);

    expect(res.status).toBe(500);
    expect(mockSentry.captureException).toHaveBeenCalledWith(conflictError, { tags: { type: 'disbursement_failure' } });
  });
});
describe('debit route — eligibility regressions', () => {
  const approvedRequest = () =>
    makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'k1' } });

  function scoringBody() {
    const call = (global.fetch as jest.Mock).mock.calls[0];
    return JSON.parse(call[1].body);
  }

  it('does not treat a brand-new customer as having an active obligation', async () => {
    // Once a bug: counting by `customerId: undefined` dropped the filter and
    // matched any loan. The count is keyed by this meter's own token, which
    // is always present, so it can only ever see this meter's advances.
    mockPrisma.customer.findUnique.mockResolvedValue(null);
    mockPrisma.obligation.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(makeTxMock()));

    await debitPost(approvedRequest());

    expect(mockPrisma.obligation.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ meterToken: 'MT-001', remainingKobo: { gt: 0 } }),
    });
    expect(mockPrisma.obligation.count.mock.calls[0][0].where).not.toHaveProperty('customerId');
    expect(scoringBody().has_active_obligation).toBe(false);
  });

  it('declines locally when the meter is already at the concurrent obligation limit', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue({ id: 100, meterToken: 'MT-001', band: 'B', status: 'active' });
    mockPrisma.obligation.count.mockResolvedValue(1); // default maxConcurrentObligations = 1

    const res = await debitPost(approvedRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.decision).toBe('declined');
    expect(body.reason).toMatch(/maximum number of outstanding advances/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('declines blacklisted customers without calling the scoring engine', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue({ id: 100, meterToken: 'MT-001', band: 'B', status: 'blacklisted' });

    const res = await debitPost(approvedRequest());
    const body = await res.json();

    expect(body.decision).toBe('declined');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('declines when the scoring engine approves without a usable approved_amount', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ eligible: true, score: 700 }) }) as any;

    const res = await debitPost(approvedRequest());
    const body = await res.json();

    expect(body.decision).toBe('declined');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.decisionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: 'declined', approvedLimitKobo: null }) })
    );
  });

  it('re-checks the concurrency limit under the customer lock (race between two requests)', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue({ id: 100, meterToken: 'MT-001', band: 'B', status: 'active' });
    mockPrisma.obligation.count.mockResolvedValue(0); // passes the pre-check...
    mockPrisma.$transaction.mockImplementation(async (cb: any) =>
      cb(makeTxMock({ obligation: { count: jest.fn().mockResolvedValue(1), create: jest.fn() } })) // ...but another request won
    );

    const res = await debitPost(approvedRequest());
    const body = await res.json();

    expect(body.decision).toBe('declined');
    expect(body.reason).toMatch(/maximum number of outstanding advances/);
  });

  it('rejects a non-numeric amount with 400', async () => {
    const res = await debitPost(makeRequest({ body: { meterToken: 'MT-001', amount: '5000', disco: 'IKEDC' } }));
    expect(res.status).toBe(400);
  });

  it('uses the tariff band from vend metrics for a new customer', async () => {
    mockPrisma.customerVendMetrics.findUnique.mockResolvedValue({ meterStatus: 'active', tariffBand: 'A', totalVends: 10, vendCountLast60Days: 4 });
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock();
      return cb(capturedTx);
    });

    await debitPost(approvedRequest());

    expect(mockPrisma.burnRate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ band: 'A' }) }));
    const [insert] = customerInserts(capturedTx);
    expect(insert.slice(1)).toContain('A'); // band bound into the INSERT
  });
});

describe('debit route — first-advance race for a brand-new meter', () => {
  const request = () =>
    makeRequest({ body: { meterToken: 'MT-NEW', amount: 4000, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'k-race' } });

  it('declines (200) instead of failing (500) when a concurrent request created the meter and won', async () => {
    // Both requests read "no customer" before their transactions. By the time
    // this one holds the locks, the other has committed a customer + advance.
    mockPrisma.customer.findUnique.mockResolvedValue(null);
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ obligation: { count: jest.fn().mockResolvedValue(1), create: jest.fn() } });
      return cb(capturedTx);
    });

    const res = await debitPost(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.decision).toBe('declined');
    // Insert-if-absent, never a plain create that can hit the unique constraint.
    expect(customerInserts(capturedTx)).toHaveLength(1);
    expect(sqlOf(customerInserts(capturedTx)[0])).toMatch(/ON CONFLICT \("meterToken"\) DO NOTHING/);
    expect(capturedTx.customer.create).not.toHaveBeenCalled();
    expect(capturedTx.obligation.create).not.toHaveBeenCalled();
  });

  it('declines when the customer was blacklisted between the pre-check and the lock', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue({ id: 100, meterToken: 'MT-NEW', band: 'B', status: 'active' });
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = makeTxMock();
      tx.customer.findUniqueOrThrow.mockResolvedValue({ id: 100, meterToken: 'MT-NEW', band: 'B', status: 'blacklisted', outstanding: 0 });
      return cb(tx);
    });

    const body = await (await debitPost(request())).json();
    expect(body.decision).toBe('declined');
    expect(body.reason).toMatch(/not eligible/);
  });
});

describe('debit route — spec conformance', () => {
  const req = (amount = 4000, meterToken = 'MT-001') =>
    makeRequest({ body: { meterToken, amount, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key', 'Idempotency-Key': `k-${amount}-${meterToken}` } });

  describe('fixed obligation tiers (pilot: ₦2,000 / ₦4,000 / ₦7,000)', () => {
    beforeEach(() => {
      delete process.env.OBLIGATION_TIERS_KOBO; // the pilot default applies
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ eligible: true, approved_amount: 7000, score: 720, model_version: 'v1' }) }) as any;
    });

    it.each([2000, 4000, 7000])('accepts the ₦%i tier', async (amount) => {
      mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(makeTxMock()));
      expect((await debitPost(req(amount))).status).toBe(201);
    });

    it.each([2500, 5000, 6999])('rejects ₦%i (within min/max, not a tier) with 400 and writes nothing', async (amount) => {
      const res = await debitPost(req(amount));
      expect(res.status).toBe(400);
      expect((await res.json()).message).toMatch(/configured tiers/);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockPrisma.decisionLog.create).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  it('§3.2: declines a meter outside the cohort without calling the scoring engine, and logs it', async () => {
    mockPrisma.cohortMeter.findUnique.mockResolvedValue(null);
    const res = await debitPost(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ decision: 'declined', reason: 'Meter is not in the participating cohort' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPrisma.decisionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ decision: 'declined', modelVersion: 'rule:cohort', features: expect.objectContaining({ in_cohort: false }) }),
    }));
  });

  it('§3.2: treats a meter whose ring-fence was released as outside the cohort', async () => {
    mockPrisma.cohortMeter.findUnique.mockResolvedValue({ removedAt: new Date() });
    expect((await (await debitPost(req())).json()).reason).toBe('Meter is not in the participating cohort');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('§6.3: caps a returned limit at the envelope maximum, whatever the score', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ eligible: true, approved_amount: 50000, score: 900, model_version: 'm1' }) }) as any;
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => { capturedTx = makeTxMock(); return cb(capturedTx); });

    const body = await (await debitPost(req(7000))).json();

    expect(body.data.scoringEvaluation.approvedLimitKobo).toBe(700000);
    expect(capturedTx.decisionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ approvedLimitKobo: 700000, features: expect.objectContaining({ engine_limit_kobo: 5000000 }) }),
    }));
  });

  it('§6.1: writes the approved decision inside the disbursement transaction, tied to the transaction id', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => { capturedTx = makeTxMock(); return cb(capturedTx); });

    await debitPost(req());

    expect(mockPrisma.decisionLog.create).not.toHaveBeenCalled(); // not outside the transaction
    const logged = capturedTx.decisionLog.create.mock.calls[0][0].data;
    expect(logged).toMatchObject({ decision: 'approved', correlationId: expect.stringMatching(/^DBT-/), modelVersion: 'v1', parameterVersion: 'v1.0' });
    expect(logged.features).toMatchObject({ meter_id: 'MT-001', in_cohort: true, open_obligation_count: 0, has_active_obligation: false });
    expect(capturedTx.decisionLog.update).not.toHaveBeenCalled();
  });

  it('§6.1/§7.2: an approval that finds Wallet A short is logged as a declined decision, never as approved', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(makeTxMock({}, { walletBalanceNaira: 1 })));

    const body = await (await debitPost(req())).json();

    expect(body).toMatchObject({ decision: 'declined', reason: expect.stringMatching(/Credit wallet exhausted/) });
    expect(mockPrisma.decisionLog.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.decisionLog.create.mock.calls[0][0].data).toMatchObject({
      decision: 'declined',
      approvedLimitKobo: null,
      features: expect.objectContaining({ wallet_a_balance_kobo: 100 }),
    });
  });

  it('§10: raises a Sentry alert when the scoring service is unavailable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any;
    const body = await (await debitPost(req())).json();
    expect(body.decision).toBe('declined');
    expect(mockSentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { component: 'scoring-engine', type: 'scoring_unavailable' } });
  });

  it('§5: registers windows from the Band A burn rate (₦1,100) when no BurnRate row exists', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue({ id: 100, meterToken: 'MT-001', band: 'A', status: 'active' });
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock();
      capturedTx.customer.findUniqueOrThrow.mockResolvedValue({ id: 100, meterToken: 'MT-001', band: 'A', status: 'active', outstanding: 0 });
      return cb(capturedTx);
    });

    await debitPost(req(4000)); // disbursed ₦3,636 -> Band A table row: watch 7, delayed 13, default 21

    const data = capturedTx.obligation.create.mock.calls[0][0].data;
    const days = (d: Date) => Math.round((d.getTime() - data.disbursementDate.getTime()) / 86_400_000);
    expect([days(data.watchDate), days(data.delayedDate), days(data.defaultDate)]).toEqual([7, 13, 21]);
    expect(data.windowParameterVersion).toBe('spec-5.2');
  });
});

describe('debit route — overload', () => {
  const req = () => makeRequest({ body: { meterToken: 'MT-001', amount: 5000, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'k-over' } });

  it('answers 503 with Retry-After (not 500) when the pool is exhausted, and logs no decision', async () => {
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' }));

    const res = await debitPost(req());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('2');
    expect(mockSentry.captureException).not.toHaveBeenCalledWith(expect.anything(), { tags: { type: 'disbursement_failure' } });
  });

  it('skips the scoring call and the transaction when the caller has disconnected', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = req();
    r.signal = controller.signal;

    const res = await debitPost(r);

    expect(res.status).toBe(499);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
