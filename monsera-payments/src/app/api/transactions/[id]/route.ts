import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import { safeAggregatorSelect, safeDiscoSelect } from '../../../../lib/safe-select';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';
import { transactionScopeFor } from '../../../../lib/access-scope';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/transactions/:id
 * All authenticated users
 */
async function getHandler(request: AuthenticatedRequest, 
  context: { params: Promise<{ id: string }> | { id: string }}) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  const scope = await transactionScopeFor(request.user!);
  const transaction = await prisma.transactions.findFirst({ where: { id, ...scope },   include: { aggregator: { select: safeAggregatorSelect }, customer: true, discoAdmin: { select: safeDiscoSelect } } });
  if (!transaction) return NextResponse.json({ success: false, message: 'Transaction not found' }, { status: 404, headers: getCorsHeaders(request.headers.get('origin')) });

  return NextResponse.json({ success: true, data: transaction }, { headers: getCorsHeaders(request.headers.get('origin')) });
}

// Spec §10: transactions are part of the immutable audit trail. The former
// PUT/DELETE handlers (edit or delete any ledger row) are removed; a
// correction is made by recording a new, compensating transaction.

// Exports with auth
export const GET = authenticate(getHandler);
