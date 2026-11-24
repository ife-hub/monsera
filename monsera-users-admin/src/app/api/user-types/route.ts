// app/api/user-types/route.ts
import { NextResponse } from '../../../lib/next-server';
import { UserType } from '@prisma/client';
import { authenticate, AuthenticatedRequest } from '../../../middleware/auth';
import { handleOptions } from '../../../lib/cors';

// CORS preflight — browsers send this before any request carrying Authorization.
export function OPTIONS(request: Request) {
  return handleOptions(request);
}

async function getHandler(request: AuthenticatedRequest) {
  // Return enum values
  return NextResponse.json({ success: true, data: Object.values(UserType) });
}

export const GET = authenticate(getHandler); // all logged-in users can fetch