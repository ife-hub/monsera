import { NextResponse } from '../../../lib/next-server';
import { safeUserSelect } from '../../../lib/safe-select';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType, AdminType } from '@prisma/client';
import { handleOptions } from '../../../lib/cors';

// CORS preflight — browsers send this before any request carrying Authorization.
export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/system-admin
 * Only MONSERA_ADMIN
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const admins = await prisma.systemAdmin.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            userType: true,
            isActive: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ success: true, data: admins });
  } catch (error) {
    console.error('Fetch system admins error:', error);
    return NextResponse.json({ success: false, message: 'Failed to fetch system admins' }, { status: 500 });
  }
}

/**
 * POST /api/system-admin
 * Only MONSERA_ADMIN
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const { userId, adminType, permissions } = await request.json();

    if (!userId || !adminType) {
      return NextResponse.json({ success: false, message: 'Missing required fields' }, { status: 400 });
    }

    // Ensure user exists
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return NextResponse.json({ success: false, message: 'User not found' }, { status: 404 });

    const created = await prisma.systemAdmin.create({
      data: {
        userId,
        adminType,
        permissions: permissions ?? {},
      },
      include: { user: { select: safeUserSelect } },
    });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Created system admin for user ${user.email}`,
      },
    });

    return NextResponse.json({ success: true, data: created }, { status: 201 });
  } catch (error) {
    console.error('Create system admin error:', error);
    if ((error as any).code === 'P2002') {
      return NextResponse.json({ success: false, message: 'SystemAdmin already exists for this user' }, { status: 400 });
    }
    return NextResponse.json({ success: false, message: 'Failed to create system admin' }, { status: 500 });
  }
}

// Exports with auth
export const GET = authorize(UserType.MONSERA_ADMIN)(getHandler);
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);