jest.mock('@sentry/nextjs', () => ({ __esModule: true, captureException: jest.fn() }));
jest.mock('@/lib/events', () => ({ __esModule: true, publishObligationStatusChanged: jest.fn() }));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    obligation: { findMany: jest.fn(), update: jest.fn() },
    audit: { create: jest.fn() },
  },
}));

import * as Sentry from '@sentry/nextjs';
import prisma from '@/lib/prisma';
import { runObligationStatusSweep } from '@/lib/jobs/obligation-status-sweep';

const mockPrisma = prisma as any;
const mockSentry = Sentry as unknown as { captureException: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockPublish = require('@/lib/events').publishObligationStatusChanged as jest.Mock;
const disbursementDate = new Date('2026-01-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const makeObligation = (overrides: Partial<any> = {}) => ({
  id: 1, status: 'Current', disbursementDate, suspensions: [] as any[],
  watchDate: new Date(disbursementDate.getTime() + 10 * DAY),
  delayedDate: new Date(disbursementDate.getTime() + 20 * DAY),
  defaultDate: new Date(disbursementDate.getTime() + 30 * DAY),
  meterToken: 'MT-1', discoAdminId: 7, remainingKobo: 100000,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.obligation.update.mockResolvedValue({});
  mockPrisma.audit.create.mockResolvedValue({});
});

afterEach(() => {
  jest.useRealTimers();
});

describe('runObligationStatusSweep', () => {
  it('leaves an obligation "Current" when elapsed time is below the watch threshold', async () => {
    jest.useFakeTimers().setSystemTime(new Date(disbursementDate.getTime() + 5 * DAY));
    mockPrisma.obligation.findMany.mockResolvedValue([makeObligation()]);

    const result = await runObligationStatusSweep();
    expect(mockPrisma.obligation.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ watched: 0, delayed: 0, defaulted: 0, total: 1 });
  });

  it('transitions to "Watch" without an alert', async () => {
    jest.useFakeTimers().setSystemTime(new Date(disbursementDate.getTime() + 15 * DAY));
    mockPrisma.obligation.findMany.mockResolvedValue([makeObligation()]);

    const result = await runObligationStatusSweep();
    expect(mockSentry.captureException).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(result.watched).toBe(1);
  });

  it('transitions to "Delayed", sends the change to the notifications digest and writes an audit alert line', async () => {
    jest.useFakeTimers().setSystemTime(new Date(disbursementDate.getTime() + 25 * DAY));
    mockPrisma.obligation.findMany.mockResolvedValue([makeObligation()]);

    const result = await runObligationStatusSweep();
    expect(mockPublish).toHaveBeenCalledWith({
      obligationId: 1, meterToken: 'MT-1', discoAdminId: 7, from: 'Current', to: 'Delayed', remainingKobo: 100000,
    });
    // One digest instead of one critical alert per obligation.
    expect(mockSentry.captureException).not.toHaveBeenCalled();
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringContaining('Obligation status alert') }) })
    );
    expect(result.delayed).toBe(1);
  });

  it('transitions to "Default" and sends the change to the notifications digest', async () => {
    jest.useFakeTimers().setSystemTime(new Date(disbursementDate.getTime() + 35 * DAY));
    mockPrisma.obligation.findMany.mockResolvedValue([makeObligation()]);

    const result = await runObligationStatusSweep();
    expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ obligationId: 1, from: 'Current', to: 'Default' }));
    expect(result.defaulted).toBe(1);
  });

  it('does not accrue days while a suspension is open (§5.3)', async () => {
    jest.useFakeTimers().setSystemTime(new Date(disbursementDate.getTime() + 35 * DAY));
    // Suspended from day 5 and still open: the clock stopped at 5 elapsed days.
    mockPrisma.obligation.findMany.mockResolvedValue([
      makeObligation({ suspensions: [{ reason: 'meter_unavailable', startedAt: new Date(disbursementDate.getTime() + 5 * DAY), endedAt: null }] }),
    ]);

    const result = await runObligationStatusSweep();
    expect(mockPrisma.obligation.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ watched: 0, delayed: 0, defaulted: 0, total: 1 });
  });

  it('subtracts closed suspension periods from elapsed time', async () => {
    jest.useFakeTimers().setSystemTime(new Date(disbursementDate.getTime() + 25 * DAY));
    // 25 calendar days less a 10-day dispute = 15 elapsed: Watch (10), not Delayed (20).
    mockPrisma.obligation.findMany.mockResolvedValue([
      makeObligation({ suspensions: [{ reason: 'customer_dispute', startedAt: new Date(disbursementDate.getTime() + 2 * DAY), endedAt: new Date(disbursementDate.getTime() + 12 * DAY) }] }),
    ]);

    const result = await runObligationStatusSweep();
    expect(result.delayed).toBe(0);
    expect(result.watched).toBe(1);
  });

  it('lists obligations on Watch in the daily report audit line', async () => {
    jest.useFakeTimers().setSystemTime(new Date(disbursementDate.getTime() + 15 * DAY));
    mockPrisma.obligation.findMany.mockResolvedValue([makeObligation({ id: 42, meterToken: 'MT-42' })]);

    await runObligationStatusSweep();
    expect(mockPrisma.audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activity: expect.stringContaining('on Watch (1): 42(MT-42, day 15)') }) })
    );
  });

  it('propagates the job tag and rethrows on a query failure', async () => {
    const error = new Error('DB down');
    mockPrisma.obligation.findMany.mockRejectedValue(error);

    await expect(runObligationStatusSweep()).rejects.toThrow('DB down');
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      error, expect.objectContaining({ tags: { job: 'obligation-status' } })
    );
  });
});