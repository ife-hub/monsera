import { endSuspension, isSuspensionReason, startSuspension } from '@/lib/suspensions';
import { parseMeterTokens } from '@/lib/cohort';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

const DAY = 86_400_000;
const disbursed = new Date('2026-01-01T00:00:00Z');

function txMock() {
  return {
    obligation: {
      findMany: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ disbursementDate: disbursed }),
      update: jest.fn().mockResolvedValue({}),
    },
    obligationSuspension: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as any;
}

describe('clock suspension service (§5.3)', () => {
  it('recognises exactly the four §5.3 grounds', () => {
    expect(['meter_unavailable', 'ring_fence_changed', 'customer_dispute', 'disco_systems_unavailable'].every(isSuspensionReason)).toBe(true);
    expect(isSuspensionReason('payment_holiday')).toBe(false);
  });

  it('records a suspension event per open obligation and marks the clock suspended', async () => {
    const tx = txMock();
    const at = new Date(disbursed.getTime() + 3 * DAY);

    const ids = await startSuspension(tx, { meterToken: 'MT-1' }, 'customer_dispute', at);

    expect(ids).toEqual([1, 2]);
    expect(tx.obligation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ meterToken: 'MT-1', suspensions: { none: { reason: 'customer_dispute', endedAt: null } } }),
    }));
    expect(tx.obligationSuspension.createMany).toHaveBeenCalledWith({
      data: [
        { obligationId: 1, reason: 'customer_dispute', startedAt: at },
        { obligationId: 2, reason: 'customer_dispute', startedAt: at },
      ],
    });
    expect(tx.obligation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ clockSuspended: true }) }));
  });

  it('is a no-op when every obligation is already suspended for that reason', async () => {
    const tx = txMock();
    tx.obligation.findMany.mockResolvedValue([]);
    expect(await startSuspension(tx, { meterToken: 'MT-1' }, 'customer_dispute', new Date())).toEqual([]);
    expect(tx.obligationSuspension.createMany).not.toHaveBeenCalled();
  });

  it('closes the open suspension and caches whole suspended days, keeping the clock suspended if another is open', async () => {
    const tx = txMock();
    const endedAt = new Date(disbursed.getTime() + 9 * DAY);
    tx.obligationSuspension.findMany
      .mockResolvedValueOnce([{ id: 10, obligationId: 1 }]) // open rows to close
      .mockResolvedValueOnce([ // history after closing
        { reason: 'customer_dispute', startedAt: new Date(disbursed.getTime() + 2 * DAY), endedAt },
        { reason: 'meter_unavailable', startedAt: new Date(disbursed.getTime() + 8 * DAY), endedAt: null },
      ]);

    const ids = await endSuspension(tx, { meterToken: 'MT-1' }, 'customer_dispute', endedAt);

    expect(ids).toEqual([1]);
    expect(tx.obligationSuspension.updateMany).toHaveBeenCalledWith({ where: { id: { in: [10] } }, data: { endedAt } });
    expect(tx.obligation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      data: expect.objectContaining({ suspendedDays: 7, clockSuspended: true }),
    }));
  });
});

describe('cohort file parsing', () => {
  it('reads APLE\'s vend-metrics JSON (meter_id), plain JSON arrays and CSV/line lists', () => {
    expect(parseMeterTokens(JSON.stringify([{ meter_id: 'Z6rdN8P8' }, { meterToken: 'Q1' }, 'R2']))).toEqual(['Z6rdN8P8', 'Q1', 'R2']);
    expect(parseMeterTokens('meter_token,district\nAAA,Aba\n"BBB",Ariaria\n')).toEqual(['AAA', 'BBB']);
  });
});
