jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    aggregator: { findUnique: jest.fn() },
    discoAdmin: { findUnique: jest.fn() },
    financeHouse: { findUnique: jest.fn() },
  },
}));

import prisma from '@/lib/prisma';
import { staffOrSelf, floatLedgerScopeFor } from '@/lib/record-access';

const mockPrisma = prisma as any;
const handler = jest.fn(async () => new Response('ok'));
const req = (userType: string, userId = 5) => ({ user: { userId, userType, email: 'x@y.z' } }) as any;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => jest.clearAllMocks());

describe('staffOrSelf', () => {
  it.each(['MONSERA_ADMIN', 'EMPLOYEE'])('lets %s read any record', async (type) => {
    const res = await staffOrSelf('disco', handler)(req(type), ctx('9'));
    expect(res.status).toBe(200);
    expect(mockPrisma.discoAdmin.findUnique).not.toHaveBeenCalled();
  });

  it('lets a disco read its own record', async () => {
    mockPrisma.discoAdmin.findUnique.mockResolvedValue({ userId: 5 });
    const res = await staffOrSelf('disco', handler)(req('DISCO_ADMIN', 5), ctx('9'));
    expect(res.status).toBe(200);
  });

  it("answers 404 for another disco's record", async () => {
    mockPrisma.discoAdmin.findUnique.mockResolvedValue({ userId: 6 });
    const res = await staffOrSelf('disco', handler)(req('DISCO_ADMIN', 5), ctx('9'));
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 404 to a different kind of partner without a lookup', async () => {
    const res = await staffOrSelf('disco', handler)(req('AGGREGATOR', 5), ctx('9'));
    expect(res.status).toBe(404);
    expect(mockPrisma.discoAdmin.findUnique).not.toHaveBeenCalled();
  });
});

describe('floatLedgerScopeFor', () => {
  it('gives admins everything and finance houses / discos their own rows', async () => {
    expect(await floatLedgerScopeFor({ userId: 1, userType: 'MONSERA_ADMIN' })).toEqual({});
    mockPrisma.financeHouse.findUnique.mockResolvedValue({ id: 3 });
    expect(await floatLedgerScopeFor({ userId: 1, userType: 'FINANCE_HOUSE' })).toEqual({ financeHouseId: 3 });
    mockPrisma.discoAdmin.findUnique.mockResolvedValue({ id: 4 });
    expect(await floatLedgerScopeFor({ userId: 1, userType: 'DISCO_ADMIN' })).toEqual({ discoAdminId: 4 });
    expect(await floatLedgerScopeFor({ userId: 1, userType: 'AGGREGATOR' })).toBeNull();
  });
});
