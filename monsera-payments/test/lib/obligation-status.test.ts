jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    idempotencyRecord: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

import prisma from '@/lib/prisma';
import {
  checkIdempotency,
  saveIdempotencyRecordTx,
  saveIdempotencyRecord,
} from '@/lib/idempotency';

const mockedFindUnique = (prisma as any).idempotencyRecord.findUnique as jest.Mock;
const mockedCreate = (prisma as any).idempotencyRecord.create as jest.Mock;
const corsHeaders = { 'Access-Control-Allow-Origin': 'https://app.plugmonsera.com' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkIdempotency', () => {
  it('returns a 400 when the key is empty', async () => {
    const res = await checkIdempotency('', 1, 'aggregator', corsHeaders);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.message).toMatch(/Idempotency-Key header is required/i);
  });

  it('returns null when no record exists for the key', async () => {
    mockedFindUnique.mockResolvedValue(null);
    const res = await checkIdempotency('key-123', 1, 'aggregator', corsHeaders);
    expect(res).toBeNull();
    expect(mockedFindUnique).toHaveBeenCalledWith({ where: { key: 'key-123' } });
  });

  it('returns 403 when the record belongs to a different aggregator', async () => {
    mockedFindUnique.mockResolvedValue({
      key: 'key-123',
      aggregatorId: 999,
      discoAdminId: null,
      responseStatus: 201,
      responseBody: { success: true },
    });
    const res = await checkIdempotency('key-123', 1, 'aggregator', corsHeaders);
    expect(res!.status).toBe(403);
  });

  it('returns 403 when the record belongs to a different disco admin', async () => {
    mockedFindUnique.mockResolvedValue({
      key: 'key-123',
      aggregatorId: null,
      discoAdminId: 999,
      responseStatus: 201,
      responseBody: { success: true },
    });
    const res = await checkIdempotency('key-123', 1, 'disco', corsHeaders);
    expect(res!.status).toBe(403);
  });

  it('returns 403 when caller type does not match the record ownership at all', async () => {
    mockedFindUnique.mockResolvedValue({
      key: 'key-123',
      aggregatorId: 1,
      discoAdminId: null,
      responseStatus: 201,
      responseBody: { success: true },
    });
    const res = await checkIdempotency('key-123', 1, 'disco', corsHeaders);
    expect(res!.status).toBe(403);
  });

  it('replays the cached response and status for a record owned by the caller', async () => {
    const storedBody = { success: true, decision: 'approved', data: { foo: 'bar' } };
    mockedFindUnique.mockResolvedValue({
      key: 'key-123',
      aggregatorId: 1,
      discoAdminId: null,
      responseStatus: 201,
      responseBody: storedBody,
    });
    const res = await checkIdempotency('key-123', 1, 'aggregator', corsHeaders);
    expect(res!.status).toBe(201);
    expect(res!.headers.get('X-Idempotent-Replay')).toBe('true');
    const body = await res!.json();
    expect(body).toEqual(storedBody);
  });

  it('preserves the passed-in corsHeaders on the replay branch', async () => {
    mockedFindUnique.mockResolvedValue({
      key: 'key-123',
      aggregatorId: 1,
      discoAdminId: null,
      responseStatus: 201,
      responseBody: {},
    });
    const res = await checkIdempotency('key-123', 1, 'aggregator', corsHeaders);
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBe('https://app.plugmonsera.com');
  });

  it('preserves the passed-in corsHeaders on the 403 ownership-mismatch branch', async () => {
    mockedFindUnique.mockResolvedValue({
      key: 'key-123',
      aggregatorId: 999,
      discoAdminId: null,
      responseStatus: 201,
      responseBody: {},
    });
    const res = await checkIdempotency('key-123', 1, 'aggregator', corsHeaders);
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBe('https://app.plugmonsera.com');
  });
});

describe('saveIdempotencyRecordTx', () => {
  it('creates a record via the transaction client with the caller as aggregatorId', async () => {
    const tx = { idempotencyRecord: { create: jest.fn().mockResolvedValue({}) } };
    const body = { success: true, decision: 'approved' };

    await saveIdempotencyRecordTx(tx as any, 'key-abc', 42, 'aggregator', 201, body);

    expect(tx.idempotencyRecord.create).toHaveBeenCalledTimes(1);
    const callArg = tx.idempotencyRecord.create.mock.calls[0][0];
    expect(callArg.data.key).toBe('key-abc');
    expect(callArg.data.aggregatorId).toBe(42);
    expect(callArg.data.discoAdminId).toBeNull();
    expect(callArg.data.responseStatus).toBe(201);
    expect(callArg.data.responseBody).toEqual(body);
  });

  it('creates a record with the caller as discoAdminId when callerType is "disco"', async () => {
    const tx = { idempotencyRecord: { create: jest.fn().mockResolvedValue({}) } };
    await saveIdempotencyRecordTx(tx as any, 'key-abc', 7, 'disco', 201, {});

    const callArg = tx.idempotencyRecord.create.mock.calls[0][0];
    expect(callArg.data.aggregatorId).toBeNull();
    expect(callArg.data.discoAdminId).toBe(7);
  });

  it('sets expiresAt to exactly 24 hours from now', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const tx = { idempotencyRecord: { create: jest.fn().mockResolvedValue({}) } };

    await saveIdempotencyRecordTx(tx as any, 'key-abc', 1, 'aggregator', 201, {});

    const callArg = tx.idempotencyRecord.create.mock.calls[0][0];
    expect((callArg.data.expiresAt as Date).toISOString()).toBe('2026-01-02T00:00:00.000Z');

    jest.useRealTimers();
  });

  it('propagates a unique-constraint violation thrown by the create call — this is the collision path the atomic write relies on', async () => {
    const conflictError = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const tx = { idempotencyRecord: { create: jest.fn().mockRejectedValue(conflictError) } };

    await expect(
      saveIdempotencyRecordTx(tx as any, 'key-abc', 1, 'aggregator', 201, {})
    ).rejects.toBe(conflictError);
  });

  it('stores the response body exactly as given, without mutating it', async () => {
    const tx = { idempotencyRecord: { create: jest.fn().mockResolvedValue({}) } };
    const body = { success: true, data: { nested: { value: 1 } } };

    await saveIdempotencyRecordTx(tx as any, 'key-abc', 1, 'aggregator', 201, body);

    const callArg = tx.idempotencyRecord.create.mock.calls[0][0];
    expect(callArg.data.responseBody).toBe(body); // same reference, not cloned/altered
  });
});

describe('saveIdempotencyRecord (standalone, non-transactional)', () => {
  it('creates a record via the module-level prisma client, not a passed-in tx', async () => {
    mockedCreate.mockResolvedValue({});
    const body = { success: true };

    await saveIdempotencyRecord('key-standalone', 5, 'disco', 200, body);

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const callArg = mockedCreate.mock.calls[0][0];
    expect(callArg.data.key).toBe('key-standalone');
    expect(callArg.data.discoAdminId).toBe(5);
    expect(callArg.data.aggregatorId).toBeNull();
    expect(callArg.data.responseStatus).toBe(200);
    expect(callArg.data.responseBody).toEqual(body);
  });

  it('sets expiresAt to 24 hours from now, same as the transactional version', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    mockedCreate.mockResolvedValue({});

    await saveIdempotencyRecord('key-standalone', 1, 'aggregator', 200, {});

    const callArg = mockedCreate.mock.calls[0][0];
    expect((callArg.data.expiresAt as Date).toISOString()).toBe('2026-06-02T12:00:00.000Z');

    jest.useRealTimers();
  });
});