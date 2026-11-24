jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    vendRecord: { findMany: jest.fn(), findUnique: jest.fn(), createMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    vendRecordRevision: { createMany: jest.fn() },
    vendIngestionFailure: { createMany: jest.fn() },
  },
}));

jest.mock('@/lib/queues', () => ({
  __esModule: true,
  vendMetricsQueue: { add: jest.fn() },
}));

import prisma from '@/lib/prisma';
import { vendMetricsQueue } from '@/lib/queues';
import { ingestVends } from '@/lib/vend/ingest';

const mockPrisma = prisma as any;
const mockQueueAdd = vendMetricsQueue.add as jest.Mock;

const validVend = (overrides: Record<string, any> = {}): any => ({
  partnerVendId: 'ABP-1',
  meterToken: 'MT-001',
  amountKobo: 5000,
  vendType: 'PREPAID_TOKEN',
  vendStatus: 'SUCCESSFUL',
  vendedAt: '2026-03-01T10:00:00.000Z',
  ...overrides,
});

const storedVend = (overrides: Record<string, any> = {}) => ({
  id: 1,
  partnerVendId: 'ABP-1',
  meterToken: 'MT-001',
  amountKobo: 5000,
  vendType: 'PREPAID_TOKEN',
  vendStatus: 'SUCCESSFUL',
  vendedAt: new Date('2026-03-01T10:00:00.000Z'),
  ...overrides,
});

/** All failure rows written across every createMany call. */
const failureRows = () => mockPrisma.vendIngestionFailure.createMany.mock.calls.flatMap((c: any) => c[0].data);
const createdRows = () => mockPrisma.vendRecord.createMany.mock.calls.flatMap((c: any) => c[0].data);
const revisionRows = () => mockPrisma.vendRecordRevision.createMany.mock.calls.flatMap((c: any) => c[0].data);

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.vendRecord.findMany.mockResolvedValue([]);
  mockPrisma.vendRecord.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.vendRecord.create.mockResolvedValue({});
  mockPrisma.vendRecord.update.mockResolvedValue({});
  mockPrisma.vendRecordRevision.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.vendIngestionFailure.createMany.mockResolvedValue({ count: 1 });
  mockQueueAdd.mockResolvedValue({});
});

describe('ingestVends: validation', () => {
  it.each([
    ['missing partnerVendId', { partnerVendId: undefined }, /partnerVendId/],
    ['partnerVendId with invalid characters', { partnerVendId: 'has space' }, /partnerVendId/],
    ['missing meterToken', { meterToken: '' }, /meterToken/],
    ['non-integer amountKobo', { amountKobo: 50.5 }, /amountKobo/],
    ['zero amountKobo', { amountKobo: 0 }, /amountKobo/],
    ['string amountKobo', { amountKobo: '5000' }, /amountKobo/],
    ['unknown vendType', { vendType: 'prepaid' }, /vendType/],
    ['unknown vendStatus', { vendStatus: 'PENDING' }, /vendStatus/],
    ['missing vendStatus', { vendStatus: undefined }, /vendStatus/],
    ['invalid vendedAt', { vendedAt: 'not-a-date' }, /vendedAt/],
  ])('rejects %s', async (_label, overrides, reasonPattern) => {
    const { results } = await ingestVends(10, [validVend(overrides)]);

    expect(results[0].status).toBe('rejected');
    expect(results[0].reason).toMatch(reasonPattern);
    expect(mockPrisma.vendRecord.createMany).not.toHaveBeenCalled();
    expect(failureRows()).toHaveLength(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('rejects unrecognized fields and records their names', async () => {
    const { results } = await ingestVends(10, [validVend({ customerName: 'X' })]);

    expect(results[0].status).toBe('rejected');
    expect(results[0].reason).toMatch(/Unrecognized field\(s\): customerName/);
    expect(failureRows()[0]).toEqual(expect.objectContaining({ unrecognizedFields: 'customerName' }));
  });

  it('rejects a vend that is not a JSON object', async () => {
    const { results } = await ingestVends(10, ['abc' as any]);

    expect(results[0]).toEqual(expect.objectContaining({ partnerVendId: '(missing)', status: 'rejected' }));
    expect(results[0].reason).toMatch(/JSON object/);
  });

  it('stores submitted values as text on failure, truncated to 200 characters', async () => {
    await ingestVends(10, [validVend({ partnerVendId: 'a'.repeat(500), amountKobo: '5000' })]);

    const data = failureRows()[0];
    expect(data.submittedPartnerVendId).toHaveLength(200);
    expect(data.submittedAmountKobo).toBe('5000');
  });

  it('rejects a duplicate partnerVendId within the same batch', async () => {
    const { results } = await ingestVends(10, [validVend(), validVend()]);

    expect(results.map((r) => r.status)).toEqual(['accepted', 'rejected']);
    expect(results[1].reason).toMatch(/duplicate partnerVendId/);
  });
});

describe('ingestVends: new vends', () => {
  it('creates a Pending record with no raw payload', async () => {
    const { results, touchedMeterTokens } = await ingestVends(10, [validVend()]);

    const createData = createdRows()[0];
    expect(createData).toEqual(
      expect.objectContaining({
        discoAdminId: 10,
        partnerVendId: 'ABP-1',
        vendType: 'PREPAID_TOKEN',
        vendStatus: 'SUCCESSFUL',
        processingStatus: 'Pending',
      })
    );
    expect(createData).not.toHaveProperty('rawPayload');
    expect(results[0]).toEqual({ partnerVendId: 'ABP-1', status: 'accepted' });
    expect(touchedMeterTokens.has('MT-001')).toBe(true);
  });

  it('accepts a FAILED vend and still queues a metrics recalculation', async () => {
    const { results } = await ingestVends(10, [validVend({ vendStatus: 'FAILED' })]);

    expect(results[0].status).toBe('accepted');
    expect(createdRows()[0].vendStatus).toBe('FAILED');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('enqueues exactly one metrics job per distinct meterToken', async () => {
    await ingestVends(10, [
      validVend({ partnerVendId: 'ABP-1', meterToken: 'MT-001' }),
      validVend({ partnerVendId: 'ABP-2', meterToken: 'MT-001' }),
      validVend({ partnerVendId: 'ABP-3', meterToken: 'MT-002' }),
    ]);

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd).toHaveBeenCalledWith('recalculate-vend-metrics', { meterToken: 'MT-001' });
    expect(mockQueueAdd).toHaveBeenCalledWith('recalculate-vend-metrics', { meterToken: 'MT-002' });
  });

  it('queues without a fixed jobId, so a batch arriving mid-calculation is not dropped', async () => {
    await ingestVends(10, [validVend({ meterToken: 'MT:9' })]);
    expect(mockQueueAdd).toHaveBeenCalledWith('recalculate-vend-metrics', { meterToken: 'MT:9' });
    expect(mockQueueAdd.mock.calls[0]).toHaveLength(2);
  });
});

describe('ingestVends: resends (silent upsert)', () => {
  it('accepts an identical resend without logging a revision', async () => {
    mockPrisma.vendRecord.findMany.mockResolvedValue([storedVend()]);

    const { results } = await ingestVends(10, [validVend()]);

    expect(results[0].status).toBe('accepted');
    expect(mockPrisma.vendRecord.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.vendRecord.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.vendRecordRevision.createMany).not.toHaveBeenCalled();
  });

  it('does not log a revision when the same instant is sent in a different format', async () => {
    mockPrisma.vendRecord.findMany.mockResolvedValue([storedVend()]);

    await ingestVends(10, [validVend({ vendedAt: '2026-03-01T10:00:00Z' })]); // no milliseconds

    expect(mockPrisma.vendRecordRevision.createMany).not.toHaveBeenCalled();
  });

  it('logs a revision when the amount changes, and still accepts', async () => {
    mockPrisma.vendRecord.findMany.mockResolvedValue([storedVend({ amountKobo: 4000 })]);

    const { results } = await ingestVends(10, [validVend({ amountKobo: 5000 })]);

    expect(results[0].status).toBe('accepted');
    expect(revisionRows()[0]).toEqual(
      expect.objectContaining({ vendRecordId: 1, previousAmountKobo: 4000, newAmountKobo: 5000 })
    );
  });

  it('logs a revision when the vend status changes from FAILED to SUCCESSFUL', async () => {
    mockPrisma.vendRecord.findMany.mockResolvedValue([storedVend({ vendStatus: 'FAILED' })]);

    await ingestVends(10, [validVend({ vendStatus: 'SUCCESSFUL' })]);

    expect(revisionRows()[0]).toEqual(
      expect.objectContaining({ previousVendStatus: 'FAILED', newVendStatus: 'SUCCESSFUL' })
    );
  });

  it('marks the record Pending again after a resend so metrics are recalculated', async () => {
    mockPrisma.vendRecord.findMany.mockResolvedValue([storedVend({ amountKobo: 4000 })]);

    await ingestVends(10, [validVend({ amountKobo: 5000 })]);

    expect(mockPrisma.vendRecord.update.mock.calls[0][0].data.processingStatus).toBe('Pending');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('rejects a resend that points the same partnerVendId at a different meterToken', async () => {
    mockPrisma.vendRecord.findMany.mockResolvedValue([storedVend({ meterToken: 'MT-OLD' })]);

    const { results } = await ingestVends(10, [validVend({ meterToken: 'MT-001' })]);

    expect(results[0].status).toBe('rejected');
    expect(results[0].reason).toMatch(/different meterToken/);
    expect(mockPrisma.vendRecord.update).not.toHaveBeenCalled();
    expect(failureRows()).toHaveLength(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe('ingestVends: partial batch failure', () => {
  it('processes valid vends, reports invalid ones in order, and keeps going', async () => {
    const { results } = await ingestVends(10, [
      validVend({ partnerVendId: 'ABP-1' }),
      validVend({ partnerVendId: 'ABP-2', amountKobo: -5 }),
      validVend({ partnerVendId: 'ABP-3' }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['accepted', 'rejected', 'accepted']);
    expect(createdRows()).toHaveLength(2);
  });

  it('falls back to per-item inserts when the batch insert fails, isolating the bad row', async () => {
    mockPrisma.vendRecord.createMany.mockRejectedValue(new Error('unique violation'));
    mockPrisma.vendRecord.create.mockImplementation(async ({ data }: any) => {
      if (data.partnerVendId === 'ABP-2') throw new Error('constraint violation');
      return {};
    });

    const { results } = await ingestVends(10, [
      validVend({ partnerVendId: 'ABP-1' }),
      validVend({ partnerVendId: 'ABP-2', meterToken: 'MT-002' }),
    ]);

    expect(results[0].status).toBe('accepted');
    expect(results[1]).toEqual(expect.objectContaining({ partnerVendId: 'ABP-2', status: 'rejected' }));
    expect(failureRows()).toEqual([expect.objectContaining({ reason: 'constraint violation' })]);
  });

  it('treats a vend created by a concurrent request (P2002) as a resend, not a rejection', async () => {
    const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    mockPrisma.vendRecord.createMany.mockRejectedValue(uniqueViolation);
    mockPrisma.vendRecord.create.mockRejectedValue(uniqueViolation);
    mockPrisma.vendRecord.findUnique.mockResolvedValue(storedVend());

    const { results } = await ingestVends(10, [validVend()]);

    expect(results[0]).toEqual({ partnerVendId: 'ABP-1', status: 'accepted' });
    expect(mockPrisma.vendRecord.update).toHaveBeenCalledTimes(1);
    expect(revisionRows()).toEqual([]); // identical values: no revision
    expect(mockPrisma.vendIngestionFailure.createMany).not.toHaveBeenCalled();
  });

  it('rejects a concurrently created vend that belongs to a different meter', async () => {
    const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    mockPrisma.vendRecord.createMany.mockRejectedValue(uniqueViolation);
    mockPrisma.vendRecord.create.mockRejectedValue(uniqueViolation);
    mockPrisma.vendRecord.findUnique.mockResolvedValue(storedVend({ meterToken: 'MT-OTHER' }));

    const { results } = await ingestVends(10, [validVend()]);

    expect(results[0]).toEqual(expect.objectContaining({ status: 'rejected', reason: 'partnerVendId already exists for a different meterToken' }));
    expect(mockPrisma.vendRecord.update).not.toHaveBeenCalled();
  });
});
