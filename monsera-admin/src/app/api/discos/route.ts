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
 * GET /api/discos
 * All authenticated users
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    // Staff see every field; partners see only what they need to address a
    // disco (id, name, status), not other partners' balances or contacts.
    const isStaff = ([UserType.MONSERA_ADMIN, UserType.EMPLOYEE] as UserType[]).includes(request.user!.userType as UserType);
    const discos = isStaff
      ? await prisma.discoAdmin.findMany({ select: { ...safeDiscoSelect, user: { select: safeUserSelect } } })
      : await prisma.discoAdmin.findMany({ select: { id: true, name: true, status: true } });
    return NextResponse.json({ success: true, data: discos }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Fetch discos error:', error);
    return NextResponse.json({ success: false, message: 'Failed to fetch discos' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

/**
 * POST /api/discos
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
    const discoAdmin = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { name, email, passwordHash, userType: UserType.DISCO_ADMIN, isActive: true },
      });
      return tx.discoAdmin.create({
        data: { userId: user.id, name, mail: email, lastInteraction: new Date(), status: 'active', logoUrl },
        select: safeDiscoSelect,
      });
    });

    // Audit log
    await prisma.audit.create({
      data: { userId: request.user!.userId, employeeName: request.user!.email, emailAddress: request.user!.email, activity: `Created disco admin ${name}` },
    });

    return NextResponse.json({ success: true, data: discoAdmin }, { status: 201, headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error: any) {
    console.error('Create disco admin error:', error);
    if (error.code === 'P2002') return NextResponse.json({ success: false, message: 'Email or name already exists' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    return NextResponse.json({ success: false, message: 'Failed to create disco admin' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

export const GET = authenticate(getHandler);
// Onboarding a new disco is a Monsera decision, not something an existing disco can do.
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);