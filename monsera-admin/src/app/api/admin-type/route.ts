import { NextResponse } from '../../../lib/next-server';
import { AdminType } from '@prisma/client';
import { authenticate, AuthenticatedRequest } from '../../../middleware/auth';
import { handleOptions } from '../../../lib/cors';

// CORS preflight — browsers send this before any request carrying Authorization.
export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/admin-types
 * Returns all enum values
 * All authenticated users can access
 */
async function getHandler(request: AuthenticatedRequest) {
  return NextResponse.json({
    success: true,
    data: Object.values(AdminType), // ["MONSERA_ADMIN","DISCO_ADMIN","AGGREGATOR"]
  });
}

export const GET = authenticate(getHandler);
