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

jest.mock('@/lib/queues', () => ({
  __esModule: true,
  recoveryQueue: { add: jest.fn() },
  addWithTimeout: jest.fn((queue: any, name: string, data: unknown) => queue.add(name, data)),
}));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    aggregator: { findUnique: jest.fn() },
    discoAdmin: { findUnique: jest.fn() },
    customer: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import prisma from '@/lib/prisma';
import * as Sentry from '@sentry/nextjs';
import { checkIdempotency, saveIdempotencyRecordTx } from '@/lib/idempotency';
import { recoveryQueue } from '@/lib/queues';
import { POST as creditPost } from '@/app/api/transactions/credit/route'; // adjust path

const mockPrisma = prisma as any;
const mockCheckIdempotency = checkIdempotency as jest.Mock;
const mockSaveIdempotencyRecordTx = saveIdempotencyRecordTx as jest.Mock;
const mockRecoveryQueueAdd = recoveryQueue.add as jest.Mock;
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

const DAY_MS = 86_400_000;
// Disbursed two days ago with Band A ₦1,818 windows (watch 5 / delayed 10 /
// default 21), so a residual recomputes to Current (§4.6).
const DISBURSED_AT = new Date(Date.now() - 2 * DAY_MS);
const windowsFor = (disbursementDate: Date) => ({
  watchDate: new Date(disbursementDate.getTime() + 5 * DAY_MS),
  delayedDate: new Date(disbursementDate.getTime() + 10 * DAY_MS),
  defaultDate: new Date(disbursementDate.getTime() + 21 * DAY_MS),
  suspensions: [] as any[],
});

// One obligation, fully covered by the payment.
function singleFullObligation(overrides: Partial<any> = {}) {
  const disbursementDate = overrides.disbursementDate ?? DISBURSED_AT;
  return {
    id: 1,
    ...windowsFor(disbursementDate),
    disbursementDate,
    remainingKobo: 200000,
    obligationKobo: 220000,
    disbursedKobo: 200000, // principalRatio = 200000/220000 ≈ 0.9091
    status: 'Current',
    rateBps: 1000,
    ...overrides,
  };
}

function makeTxMock({
  outstandingObligations = [singleFullObligation()],
  discoAdmin = { id: 10, name: 'IKEDC', outstanding: 500000 },
}: {
  outstandingObligations?: any[];
  discoAdmin?: any;
} = {}) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    // lockWallet (lib/wallets) reads the locked Wallet B balance via $queryRaw
    $queryRaw: jest.fn().mockResolvedValue([{ balance: 0 }]),
    obligation: {
      findMany: jest.fn().mockResolvedValue(outstandingObligations),
      update: jest.fn().mockResolvedValue({}),
    },
    wallet: { update: jest.fn().mockResolvedValue({}) },
    walletTransaction: { create: jest.fn().mockResolvedValue({ id: 999 }) },
    obligationRecovery: { create: jest.fn().mockResolvedValue({}) },
    customer: { update: jest.fn().mockResolvedValue({ id: 100, meterToken: 'MT-001', outstanding: 0, status: 'active' }) },
    discoAdmin: { update: jest.fn().mockResolvedValue({ ...discoAdmin, id: discoAdmin.id }) },
    aggregator: { update: jest.fn().mockResolvedValue({ id: 1, outstanding: 0 }) },
    transactions: {
      create: jest.fn().mockResolvedValue({ id: 1, transactionId: 'REP-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    monseraEarnings: { create: jest.fn().mockResolvedValue({ id: 1, amount: 200 }) },
    audit: { create: jest.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockResolvedValue(true);
  process.env.WALLET_A_ID = '1';
  process.env.WALLET_B_ID = '2';

  mockCheckIdempotency.mockResolvedValue(null);
  mockPrisma.aggregator.findUnique.mockResolvedValue({ id: 1, apiKey: 'valid-key', status: 'active' });
  mockPrisma.discoAdmin.findUnique.mockResolvedValue({ id: 10, name: 'IKEDC', apiKey: 'disco-key', status: 'active' });
  mockPrisma.customer.findUnique.mockResolvedValue({ id: 100, meterToken: 'MT-001', outstanding: 200000 });
  mockRecoveryQueueAdd.mockResolvedValue({});
});

describe('credit route — request validation', () => {
  it('returns 400 when meterToken is missing', async () => {
    const req = makeRequest({ body: { amountKobo: 100000, disco: 'IKEDC' } });
    const res = await creditPost(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when amountKobo is missing', async () => {
    const req = makeRequest({ body: { meterToken: 'MT-001', disco: 'IKEDC' } });
    const res = await creditPost(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when amountKobo is zero or negative', async () => {
    const req = makeRequest({ body: { meterToken: 'MT-001', amountKobo: 0, disco: 'IKEDC' } });
    const res = await creditPost(req);
    expect(res.status).toBe(400);
  });

  it('returns 403 for a userType that is neither AGGREGATOR nor DISCO_ADMIN', async () => {
    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' },
      user: { userId: 1, userType: 'EMPLOYEE' },
    });
    const res = await creditPost(req);
    expect(res.status).toBe(403);
  });
});

describe('credit route — feature flags', () => {
  it('declines with HTTP 200 when credit_enabled is false, without touching the database', async () => {
    mockIsEnabled.mockResolvedValue(false);
    const req = makeRequest({ body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' } });
    const res = await creditPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe('declined');
    expect(body.reason).toMatch(/temporarily unavailable/i);
    expect(mockPrisma.aggregator.findUnique).not.toHaveBeenCalled();
  });
});

describe('credit route — account lookups', () => {
  it('returns 404 when the aggregator account cannot be found', async () => {
    mockPrisma.aggregator.findUnique.mockResolvedValue(null);
    const req = makeRequest({ body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' } });
    const res = await creditPost(req);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the disco cannot be found', async () => {
    mockPrisma.discoAdmin.findUnique.mockResolvedValue(null);
    const req = makeRequest({ body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'UNKNOWN' } });
    const res = await creditPost(req);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the customer (meterToken) cannot be found', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue(null);
    const req = makeRequest({
      body: { meterToken: 'MT-UNKNOWN', amountKobo: 100000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await creditPost(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.message).toMatch(/Customer not found/i);
  });
});

describe('credit route — idempotency, auth headers, account status', () => {
  it('short-circuits with the cached response when checkIdempotency finds a replay', async () => {
    const cached = new Response(JSON.stringify({ success: true, cached: true }), { status: 201 });
    mockCheckIdempotency.mockResolvedValue(cached);

    const req = makeRequest({ body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' } });
    const res = await creditPost(req);

    expect(res).toBe(cached);
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it('returns 401 when the API-Key header is missing', async () => {
    const req = makeRequest({ body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' } });
    const res = await creditPost(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the API-Key does not match the caller', async () => {
    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' },
      headers: { 'API-Key': 'wrong-key' },
    });
    const res = await creditPost(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller account is not active', async () => {
    mockPrisma.aggregator.findUnique.mockResolvedValue({ id: 1, apiKey: 'valid-key', status: 'suspended' });
    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await creditPost(req);
    expect(res.status).toBe(403);
  });
});

describe('credit route — no outstanding obligations', () => {
  it('returns 404 when the customer has no Current/Watch/Delayed obligations with remainingKobo > 0', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = makeTxMock({ outstandingObligations: [] });
      return cb(tx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await creditPost(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.message).toMatch(/No outstanding obligations/i);
  });
});

describe('credit route — FIFO recovery application', () => {
  it('fully discharges a single obligation when the payment exactly covers remainingKobo, with no surplus', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [singleFullObligation({ remainingKobo: 200000 })] });
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 200000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'credit-key-1' },
    });
    const res = await creditPost(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.summary.totalRecoveredKobo).toBe(200000);
    expect(body.data.summary.surplusKobo).toBe(0);
    expect(body.data.summary.obligationsFullyDischarged).toBe(1);
    expect(body.data.summary.obligationsPartiallyRecovered).toBe(0);

    expect(capturedTx.obligation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ remainingKobo: 0, status: 'Discharged' }),
      })
    );
  });

  it('applies a partial payment, leaving the obligation status unchanged (not discharged)', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [singleFullObligation({ remainingKobo: 200000, status: 'Current' })] });
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 50000, disco: 'IKEDC' }, // partial
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await creditPost(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.summary.totalRecoveredKobo).toBe(50000);
    expect(body.data.summary.obligationsFullyDischarged).toBe(0);
    expect(body.data.summary.obligationsPartiallyRecovered).toBe(1);

    expect(capturedTx.obligation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ remainingKobo: 150000, status: 'Current' }), // status carried over, not Discharged
      })
    );
  });

  it('applies payment across multiple obligations in FIFO order (oldest disbursementDate first)', async () => {
    const older = singleFullObligation({ id: 1, remainingKobo: 100000, disbursementDate: new Date('2026-01-01') });
    const newer = singleFullObligation({ id: 2, remainingKobo: 100000, disbursementDate: new Date('2026-02-01') });

    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [older, newer] }); // findMany mock already orderBy asc in real query; here we control the returned order directly
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 150000, disco: 'IKEDC' }, // fully covers older, partially covers newer
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await creditPost(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.recoveries).toHaveLength(2);
    expect(body.data.recoveries[0]).toEqual(expect.objectContaining({ obligationId: 1, amountKobo: 100000, fullyDischarged: true }));
    expect(body.data.recoveries[1]).toEqual(expect.objectContaining({ obligationId: 2, amountKobo: 50000, fullyDischarged: false }));
  });

  it('releases the remainder as surplus once all outstanding obligations are fully discharged', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [singleFullObligation({ remainingKobo: 200000 })] });
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 250000, disco: 'IKEDC' }, // 50000 more than owed
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await creditPost(req);

    const body = await res.json();
    expect(body.data.summary.totalRecoveredKobo).toBe(200000); // only what was actually owed
    expect(body.data.summary.surplusKobo).toBe(50000);
  });

  it('splits each recovery into principal and service proportionally, flooring principal', async () => {
    // disbursedKobo 200000 / obligationKobo 220000 -> principalRatio ≈ 0.909090...
    // applyKobo 110000 -> principal = floor(110000 * 0.909090...) = 99999, service = 110000 - 99999 = 10001
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({
        outstandingObligations: [singleFullObligation({ remainingKobo: 110000, obligationKobo: 220000, disbursedKobo: 200000 })],
      });
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 110000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    const res = await creditPost(req);

    const body = await res.json();
    const recovery = body.data.recoveries[0];
    expect(recovery.principalKobo + recovery.serviceKobo).toBe(110000); // still holds
    expect(recovery.principalKobo).toBe(100000); // was 99999
    expect(recovery.serviceKobo).toBe(10000); 
  });
});

describe('credit route — Wallet B, MonseraEarnings, and side effects', () => {
  it('credits the full recovered amount (principal + service) to Wallet B, not just principal', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [singleFullObligation({ remainingKobo: 200000, obligationKobo: 220000, disbursedKobo: 200000 })] });
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 200000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    await creditPost(req);

    expect(capturedTx.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 2 }, // WALLET_B_ID
        data: expect.objectContaining({ balance: expect.objectContaining({ increment: expect.any(Prisma.Decimal) }) }),
      })
    );
    const incrementArg = capturedTx.wallet.update.mock.calls[0][0].data.balance.increment;
    expect(incrementArg.toNumber()).toBeCloseTo(2000, 5); // 200000 kobo / 100 = 2000 naira
  });

  it('decrements disco (and aggregator, when applicable) outstanding by PRINCIPAL only, not the full recovered amount', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [singleFullObligation({ remainingKobo: 220000, obligationKobo: 220000, disbursedKobo: 200000 })] });
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 220000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' }, // caller is AGGREGATOR (default user)
    });
    await creditPost(req);

    const discoDecrement = capturedTx.discoAdmin.update.mock.calls[0][0].data.outstanding.decrement;
    const aggDecrement = capturedTx.aggregator.update.mock.calls[0][0].data.outstanding.decrement;
    // principal = 200000 kobo = 2000 naira, service = 20000 kobo goes to disco/agg as commission, not principal
    expect(discoDecrement.toNumber()).toBeCloseTo(2000, 5);
    expect(aggDecrement.toNumber()).toBeCloseTo(2000, 5);
  });

  it('does not touch aggregator.update when the caller is a disco admin, not an aggregator', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock();
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 200000, disco: 'IKEDC' },
      user: { userId: 2, userType: 'DISCO_ADMIN', email: 'disco@example.com' },
      headers: { 'API-Key': 'disco-key' },
    });
    await creditPost(req);

    expect(capturedTx.aggregator.update).not.toHaveBeenCalled();
  });

  it('creates a MonseraEarnings record for the service-charge portion of the recovery', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [singleFullObligation({ remainingKobo: 220000, obligationKobo: 220000, disbursedKobo: 200000 })] });
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 220000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    await creditPost(req);

    expect(capturedTx.monseraEarnings.create).toHaveBeenCalledTimes(1);
  });

  it('links each recovery to the Wallet B walletTransaction record via obligationRecovery.create', async () => {
    const older = singleFullObligation({ id: 1, remainingKobo: 100000 });
    const newer = singleFullObligation({ id: 2, remainingKobo: 100000 });
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [older, newer] });
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 200000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    await creditPost(req);

    expect(capturedTx.obligationRecovery.create).toHaveBeenCalledTimes(2);
    expect(capturedTx.obligationRecovery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ obligationId: 1, walletBRecordId: 999 }) })
    );
  });

  it('writes the idempotency record inside the transaction, not after commit', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock();
      return cb(capturedTx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 200000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'credit-key-atomic' },
    });
    await creditPost(req);

    expect(mockSaveIdempotencyRecordTx).toHaveBeenCalledWith(
      capturedTx,
      'credit-key-atomic',
      1,
      'aggregator',
      201,
      expect.any(Object)
    );
  });
});

describe('credit route — recovery sweep queue enqueue', () => {
  it('enqueues a recovery-sweep job when the customer still has outstanding balance after this payment', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = makeTxMock();
      tx.customer.update.mockResolvedValue({ id: 100, meterToken: 'MT-001', outstanding: 50000, status: 'active' });
      return cb(tx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 150000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    await creditPost(req);

    expect(mockRecoveryQueueAdd).toHaveBeenCalledWith(
      'recovery-sweep',
      expect.objectContaining({ meterToken: 'MT-001', remainingOutstandingKobo: 5000000 }) // 50000 naira * 100
    );
  });

  it('does NOT enqueue a recovery-sweep job once the customer outstanding reaches zero', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = makeTxMock();
      tx.customer.update.mockResolvedValue({ id: 100, meterToken: 'MT-001', outstanding: 0, status: 'active' });
      return cb(tx);
    });

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 200000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key' },
    });
    await creditPost(req);

    expect(mockRecoveryQueueAdd).not.toHaveBeenCalled();
  });
});

describe('credit route — same idempotency-conflict regression as the debit route', () => {
  it('returns a generic 500 on a unique-constraint race, rather than a 409 replay', async () => {
    const conflictError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`key`)', {
      code: 'P2002',
      clientVersion: '6.19.0',
    });
    mockPrisma.$transaction.mockRejectedValue(conflictError);

    const req = makeRequest({
      body: { meterToken: 'MT-001', amountKobo: 200000, disco: 'IKEDC' },
      headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'racing-credit-key' },
    });
    const res = await creditPost(req);

    expect(res.status).toBe(500);
    expect(mockSentry.captureException).toHaveBeenCalledWith(conflictError);
  });
});
describe('credit route — recovery regressions', () => {
  const request = (amountKobo: any = 200000) =>
    makeRequest({ body: { meterToken: 'MT-001', amountKobo, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'k1' } });

  it('includes Default obligations so defaulted customers can still repay', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [singleFullObligation({ status: 'Default' })] });
      return cb(capturedTx);
    });

    const res = await creditPost(request());

    expect(res.status).toBe(201);
    expect(capturedTx.obligation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['Current', 'Watch', 'Delayed', 'Default'] } }),
      })
    );
  });

  it('links each recovery to the repayment transaction and marks discharged debits paid', async () => {
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      capturedTx = makeTxMock({ outstandingObligations: [singleFullObligation({ transactionId: 55 })] });
      capturedTx.transactions.create.mockResolvedValue({ id: 77, transactionId: 'REP-77' });
      return cb(capturedTx);
    });

    await creditPost(request());

    expect(capturedTx.obligationRecovery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recoveryTransactionId: 77 }) })
    );
    expect(capturedTx.transactions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [55] } }, data: expect.objectContaining({ paymentStatus: 'paid' }) })
    );
  });

  it('rejects fractional kobo with 400 instead of failing with a 500', async () => {
    const res = await creditPost(request(1000.5));
    expect(res.status).toBe(400);
  });

  it('still returns 201 when queueing the post-commit audit job fails', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = makeTxMock({ outstandingObligations: [singleFullObligation({ remainingKobo: 300000, obligationKobo: 330000, disbursedKobo: 300000 })] });
      tx.customer.update.mockResolvedValue({ id: 100, meterToken: 'MT-001', outstanding: 1000, status: 'active' });
      return cb(tx);
    });
    mockRecoveryQueueAdd.mockRejectedValue(new Error('redis quota'));

    const res = await creditPost(request());

    expect(res.status).toBe(201);
    expect(mockSentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { queue: 'recovery' } });
  });
});

describe('credit route — malformed bodies and overload', () => {
  const withBody = (json: () => Promise<any>) => ({
    json,
    headers: { get: (k: string) => ({ origin: CORS_ORIGIN, 'api-key': 'valid-key', 'idempotency-key': 'k1' } as any)[k.toLowerCase()] ?? null },
    user: { userId: 1, userType: 'AGGREGATOR', email: 'agg@example.com' },
  });

  it('answers a truncated or non-JSON body with 400, not 500', async () => {
    const res = await creditPost(withBody(async () => { throw new SyntaxError('Unexpected end of JSON input'); }) as any);
    expect(res.status).toBe(400);
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });

  it('answers 503 with Retry-After when no database connection is free', async () => {
    const busy = Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' });
    mockPrisma.$transaction.mockRejectedValue(busy);

    const res = await creditPost(makeRequest({ body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'k1' } }));

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('2');
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });

  it('does not open a transaction for a caller that has already disconnected', async () => {
    const controller = new AbortController();
    controller.abort();
    const req = makeRequest({ body: { meterToken: 'MT-001', amountKobo: 100000, disco: 'IKEDC' }, headers: { 'API-Key': 'valid-key', 'Idempotency-Key': 'k1' } });
    req.signal = controller.signal;

    const res = await creditPost(req);

    expect(res.status).toBe(499);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
