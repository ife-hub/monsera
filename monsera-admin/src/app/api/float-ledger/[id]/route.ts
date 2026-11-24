import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';
import { floatLedgerScopeFor } from '../../../../lib/record-access';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/float-ledger/:id
 * All authenticated users
 */
async function getHandler(request: AuthenticatedRequest, 
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  // Same visibility as the list: admins all, finance houses and discos their own.
  const scope = await floatLedgerScopeFor(request.user!);
  const data = scope ? await prisma.float_Ledger.findFirst({ where: { id, ...scope } }) : null;
  if (!data) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404, headers: getCorsHeaders(request.headers.get('origin'))  });

  return NextResponse.json({ success: true, data });
}

// Spec §10: float-ledger rows are part of the immutable audit trail. The
// former PUT/DELETE handlers (including setting currentFloatBalance by hand)
// are removed; corrections are recorded as new entries.

export const GET = authenticate(getHandler);
