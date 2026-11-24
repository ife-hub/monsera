// app/api/audits/[id]/route.ts
import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import { safeUserSelect } from '../../../../lib/safe-select';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/audits/:id
 * Only MONSERA_ADMIN
 */
async function getHandler(
  request: AuthenticatedRequest,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const id = await getRouteId(context);
  
  if (isNaN(id)) {
    return NextResponse.json(
      { success: false, message: 'Invalid ID' },
      { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }

  try {
    const audit = await prisma.audit.findUnique({
      where: { id },
      include: { user: { select: safeUserSelect } },
    });

    if (!audit) {
      return NextResponse.json(
        { success: false, message: 'Audit record not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    return NextResponse.json(
      { success: true, data: audit },
      { status: 200, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Fetch audit error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch audit record' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

// Export with auth
export const GET = authorize(UserType.MONSERA_ADMIN)(getHandler);