jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    aggregator: { findUnique: jest.fn() },
    discoAdmin: { findUnique: jest.fn() },
  },
}));

import prisma from '@/lib/prisma';
import { customerScopeFor, transactionScopeFor } from '@/lib/access-scope';

const mockPrisma = prisma as any;
const user = (userType: string) => ({ userId: 7, email: 'x@y.com', userType } as any);

beforeEach(() => jest.clearAllMocks());

describe('customerScopeFor — "a customer is somebody who has taken a loan"', () => {
  it('limits an aggregator to customers with a transaction through that aggregator', async () => {
    mockPrisma.aggregator.findUnique.mockResolvedValue({ id: 3 });
    expect(await customerScopeFor(user('AGGREGATOR'))).toEqual({ transactions: { some: { aggregatorId: 3 } } });
  });

  it('limits a disco to customers with a transaction through that disco', async () => {
    mockPrisma.discoAdmin.findUnique.mockResolvedValue({ id: 10 });
    expect(await customerScopeFor(user('DISCO_ADMIN'))).toEqual({ transactions: { some: { discoAdminId: 10 } } });
  });

  it('lets Monsera staff see every customer', async () => {
    expect(await customerScopeFor(user('MONSERA_ADMIN'))).toEqual({});
    expect(await customerScopeFor(user('EMPLOYEE'))).toEqual({});
  });

  it('shows nothing to a partner login with no partner record, or to finance houses', async () => {
    mockPrisma.aggregator.findUnique.mockResolvedValue(null);
    expect(await customerScopeFor(user('AGGREGATOR'))).toEqual({ id: -1 });
    expect(await customerScopeFor(user('FINANCE_HOUSE'))).toEqual({ id: -1 });
  });
});

describe('transactionScopeFor', () => {
  it('limits an aggregator to its own transactions', async () => {
    mockPrisma.aggregator.findUnique.mockResolvedValue({ id: 3 });
    expect(await transactionScopeFor(user('AGGREGATOR'))).toEqual({ aggregatorId: 3 });
  });
});
