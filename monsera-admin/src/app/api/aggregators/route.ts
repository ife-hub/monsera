import { NextResponse } from '../../../lib/next-server';
import { safeUserSelect, safeAggregatorSelect, safeDiscoSelect } from '../../../lib/safe-select';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/aggregators
 * All authenticated users
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const aggregators = await prisma.aggregator.findMany({ select: { ...safeAggregatorSelect, user: { select: safeUserSelect } } });
    return NextResponse.json({ success: true, data: aggregators }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Fetch aggregators error:', error);
    return NextResponse.json({ success: false, message: 'Failed to fetch aggregators' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

/**
 * POST /api/aggregators
 * Only SYSTEM_ADMIN can create
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const { name, email, password, logoUrl } = await request.json();
    if (!name || !email || !password) {
      return NextResponse.json({ success: false, message: 'Missing required fields' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // User + partner rows are created together so a failure (e.g. duplicate
    // name) never leaves an orphaned login behind.
    const aggregator = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { name, email, passwordHash, userType: UserType.AGGREGATOR, isActive: true },
      });
      return tx.aggregator.create({
        data: { userId: user.id, name, mail: email, lastInteraction: new Date(), status: 'active', outstanding: 0, logoUrl },
        select: safeAggregatorSelect,
      });
    });

    // Audit log
    await prisma.audit.create({
      data: { userId: request.user!.userId, employeeName: request.user!.email, emailAddress: request.user!.email, activity: `Created aggregator ${name}` },
    });

    return NextResponse.json({ success: true, data: aggregator }, { status: 201, headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error: any) {
    console.error('Create aggregator error:', error);
    if (error.code === 'P2002') return NextResponse.json({ success: false, message: 'Email or name already exists' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    return NextResponse.json({ success: false, message: 'Failed to create aggregator' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

// Staff only: internal configuration / meter and partner data.
export const GET = authorize(UserType.MONSERA_ADMIN, UserType.EMPLOYEE)(getHandler);
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);