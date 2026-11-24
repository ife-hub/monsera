import { UserType } from '@prisma/client';
import { NextResponse } from './next-server';
import prisma from './prisma';
import { getRouteId } from './route-params';
import type { AuthenticatedRequest } from '../middleware/auth';

/**
 * Who may read which partner records.
 *
 * Staff (Monsera admins and employees) can read everything. A partner
 * (aggregator, disco, finance house) can read only its own record: one
 * partner must not see another's balances, outstanding amounts or contacts.
 * A record the caller may not see answers 404, so its existence isn't
 * revealed.
 */
export const STAFF: UserType[] = [UserType.MONSERA_ADMIN, UserType.EMPLOYEE];

export type PartnerKind = 'aggregator' | 'disco' | 'financeHouse';

const OWNER_TYPE: Record<PartnerKind, UserType> = {
  aggregator: UserType.AGGREGATOR,
  disco: UserType.DISCO_ADMIN,
  financeHouse: UserType.FINANCE_HOUSE,
};

async function ownerUserId(kind: PartnerKind, id: number): Promise<number | null> {
  const where = { where: { id }, select: { userId: true } } as const;
  const row =
    kind === 'aggregator'
      ? await prisma.aggregator.findUnique(where)
      : kind === 'disco'
        ? await prisma.discoAdmin.findUnique(where)
        : await prisma.financeHouse.findUnique(where);
  return row?.userId ?? null;
}

const notFound = () => NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });

/** Wraps an [id] handler: staff, or the partner the record belongs to. */
export function staffOrSelf(kind: PartnerKind, handler: Function) {
  return async (request: AuthenticatedRequest, context: any) => {
    const user = request.user!;
    if (STAFF.includes(user.userType as UserType)) return handler(request, context);
    if (user.userType !== OWNER_TYPE[kind]) return notFound();
    const id = await getRouteId(context);
    if (isNaN(id) || (await ownerUserId(kind, id)) !== user.userId) return notFound();
    return handler(request, context);
  };
}
