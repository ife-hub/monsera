jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { discoAdmin: { findUnique: jest.fn() }, financeHouse: { findUnique: jest.fn() } },
}));

import prisma from '@/lib/prisma';
import { floatLedgerScopeFor } from '@/lib/record-access';

const mockPrisma = prisma as any;

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
