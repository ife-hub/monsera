import { Prisma, UserType } from '@prisma/client';
import prisma from './prisma';
import type { JWTPayload } from './auth';

/** Matches nothing — used when a partner account has no partner record. */
const NOTHING = { id: -1 };

/**
 * Restricts transaction queries to what the caller may see: aggregators and
 * discos see only their own rows; Monsera staff see everything.
 */
export async function transactionScopeFor(user: JWTPayload): Promise<Prisma.TransactionsWhereInput> {
  if (user.userType === UserType.AGGREGATOR) {
    const aggregator = await prisma.aggregator.findUnique({ where: { userId: user.userId }, select: { id: true } });
    return aggregator ? { aggregatorId: aggregator.id } : NOTHING;
  }
  if (user.userType === UserType.DISCO_ADMIN) {
    const disco = await prisma.discoAdmin.findUnique({ where: { userId: user.userId }, select: { id: true } });
    return disco ? { discoAdminId: disco.id } : NOTHING;
  }
  if (user.userType === UserType.MONSERA_ADMIN || user.userType === UserType.EMPLOYEE) {
    return {};
  }
  return NOTHING;
}

/**
 * Restricts customer queries for partners. A partner's customers are the
 * meters that have taken a loan through them — i.e. have at least one
 * transaction with that aggregator / disco. Staff see every customer.
 */
export async function customerScopeFor(user: JWTPayload): Promise<Prisma.CustomerWhereInput> {
  if (user.userType === UserType.MONSERA_ADMIN || user.userType === UserType.EMPLOYEE) {
    return {};
  }
  const txScope = await transactionScopeFor(user);
  if (txScope === NOTHING) return NOTHING;
  return { transactions: { some: txScope } };
}
