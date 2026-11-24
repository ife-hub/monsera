jest.mock('@sentry/nextjs', () => ({ __esModule: true, captureException: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    discoAdmin: { findMany: jest.fn() },
    vendIngestionFailure: { findMany: jest.fn(), updateMany: jest.fn() },
    audit: { create: jest.fn() },
  },
}));

import prisma from '@/lib/prisma';
import * as Sentry from '@sentry/nextjs';
import { runVendFailureReport } from '@/lib/jobs/vend-failure-report';

const mockPrisma = prisma as any;
const fetchMock = jest.fn();
const failure = (id: number) => ({ id, submittedPartnerVendId: `V-${id}`, reason: 'amountKobo is required', createdAt: new Date('2026-11-01T10:00:00Z') });

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as any;
  process.env.NOTIFICATIONS_URL = 'http://notifications:3005/';
  process.env.INTERNAL_API_KEY = 'internal-key';
  mockPrisma.discoAdmin.findMany.mockResolvedValue([
    { id: 1, name: 'Ikeja Electric', mail: 'ops@ikeja.test' },
    { id: 2, name: 'Eko Disco', mail: 'ops@eko.test' },
  ]);
  mockPrisma.vendIngestionFailure.findMany.mockImplementation(async ({ where }: any) => (where.discoAdminId === 1 ? [failure(10), failure(11)] : []));
  mockPrisma.vendIngestionFailure.updateMany.mockResolvedValue({ count: 2 });
  mockPrisma.audit.create.mockResolvedValue({});
});

describe('runVendFailureReport', () => {
  it('sends each disco its unreported failures through notifications, then marks them reported', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const result = await runVendFailureReport();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://notifications:3005/notifications/vend-failure-report');
    expect(init.headers['X-Internal-Key']).toBe('internal-key');
    expect(JSON.parse(init.body)).toEqual({
      discoName: 'Ikeja Electric',
      discoEmail: 'ops@ikeja.test',
      failures: [
        { submittedPartnerVendId: 'V-10', reason: 'amountKobo is required', createdAt: '2026-11-01T10:00:00.000Z' },
        { submittedPartnerVendId: 'V-11', reason: 'amountKobo is required', createdAt: '2026-11-01T10:00:00.000Z' },
      ],
    });
    expect(mockPrisma.vendIngestionFailure.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [10, 11] } },
      data: { reportedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ discosReported: 1, errors: [] });
  });

  it('leaves failures unreported when delivery fails, so the next run retries them', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => 'bad gateway' });

    const result = await runVendFailureReport();

    expect(mockPrisma.vendIngestionFailure.updateMany).not.toHaveBeenCalled();
    expect((Sentry as any).captureException).toHaveBeenCalled();
    expect(result.discosReported).toBe(0);
    expect(result.errors[0]).toContain('Ikeja Electric');
  });

  it('skips a disco with no email address without marking its failures', async () => {
    mockPrisma.discoAdmin.findMany.mockResolvedValue([{ id: 1, name: 'Ikeja Electric', mail: '' }]);

    const result = await runVendFailureReport();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockPrisma.vendIngestionFailure.updateMany).not.toHaveBeenCalled();
    expect(result.errors).toEqual(['Ikeja Electric: no email address on file']);
  });

  it('does not mark anything reported when notifications is not configured', async () => {
    delete process.env.NOTIFICATIONS_URL;

    const result = await runVendFailureReport();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockPrisma.vendIngestionFailure.updateMany).not.toHaveBeenCalled();
    expect(result.errors[0]).toContain('NOTIFICATIONS_URL');
  });
});
