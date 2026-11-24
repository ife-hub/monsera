import { UserType } from '@prisma/client';
import prisma from './prisma';

/**
 * Float-ledger rows a caller may see (same rule as the float-ledger list):
 * admins everything, a finance house its own top-ups, a disco its own
 * allocations. Returns null when the caller may see none.
 */
export async function floatLedgerScopeFor(user: { userId: number; userType: string }) {
  if (user.userType === UserType.MONSERA_ADMIN) return {};
  if (user.userType === UserType.FINANCE_HOUSE) {
    const financeHouse = await prisma.financeHouse.findUnique({ where: { userId: user.userId }, select: { id: true } });
    return financeHouse ? { financeHouseId: financeHouse.id } : null;
  }
  if (user.userType === UserType.DISCO_ADMIN) {
    const disco = await prisma.discoAdmin.findUnique({ where: { userId: user.userId }, select: { id: true } });
    return disco ? { discoAdminId: disco.id } : null;
  }
  return null;
}
