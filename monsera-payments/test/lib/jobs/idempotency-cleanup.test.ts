jest.mock('@sentry/nextjs', () => ({ __esModule: true, captureException: jest.fn() }));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    idempotencyRecord: { deleteMany: jest.fn() },
    audit: { create: jest.fn() },
  },
}));

import * as Sentry from '@sentry/nextjs';
import prisma from '@/lib/prisma';
import { runIdempotencyCleanup } from '@/lib/jobs/idempotency-cleanup';

const mockPrisma = prisma as any;
const mockSentry = Sentry as unknown as { captureException: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runIdempotencyCleanup', () => {
  it('deletes expired records and logs the count', async () => {
    mockPrisma.idempotencyRecord.deleteMany.mockResolvedValue({ count: 7 });
    mockPrisma.audit.create.mockResolvedValue({});

    const result = await runIdempotencyCleanup();

    expect(mockPrisma.idempotencyRecord.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringContaining('7 expired records deleted') }) })
    );
    expect(result).toEqual({ deleted: 7 });
  });

  it('propagates the job tag and rethrows on failure', async () => {
    const error = new Error('DB down');
    mockPrisma.idempotencyRecord.deleteMany.mockRejectedValue(error);

    await expect(runIdempotencyCleanup()).rejects.toThrow('DB down');
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      error, expect.objectContaining({ tags: { job: 'idempotency-cleanup' } })
    );
  });
});