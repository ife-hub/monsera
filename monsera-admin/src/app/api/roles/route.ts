import { NextResponse } from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/roles
 * All authenticated users
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const roles = await prisma.role.findMany({
      include: {
        employees: {
          select: { id: true, userId: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    return NextResponse.json({ success: true, data: roles });
  } catch (error) {
    console.error('Fetch roles error:', error);
    return NextResponse.json({ success: false, message: 'Failed to fetch roles' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin'))  });
  }
}

/**
 * POST /api/roles
 * Only MONSERA_ADMIN
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const {
      name,
      description,
      canViewTransactions,
      canManageTransactions,
      canViewUsers,
      canManageUsers,
      canBlacklistUsers,
      canActivateUsers,
      canViewScoringEngine,
      canEditThreshold,
      canValidateLoans
    } = await request.json();

    if (!name || !description) {
      return NextResponse.json({ success: false, message: 'Missing required fields' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    }

    const created = await prisma.role.create({
      data: {
        name,
        description,
        canViewTransactions: canViewTransactions ?? false,
        canManageTransactions: canManageTransactions ?? false,
        canViewUsers: canViewUsers ?? false,
        canManageUsers: canManageUsers ?? false,
        canBlacklistUsers: canBlacklistUsers ?? false,
        canActivateUsers: canActivateUsers ?? false,
        canViewScoringEngine: canViewScoringEngine ?? false,
        canEditThreshold: canEditThreshold ?? false,
        canValidateLoans: canValidateLoans ?? false,
      }
    });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Created role ${created.name}`,
      },
    });

    return NextResponse.json({ success: true, data: created }, { status: 201, headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error: any) {
    console.error('Create role error:', error);
    if (error.code === 'P2002') {
      return NextResponse.json({ success: false, message: 'Role name already exists' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    }
    return NextResponse.json({ success: false, message: 'Failed to create role' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin'))   });
  }
}

// Exports with auth
// Staff only: internal configuration / meter and partner data.
export const GET = authorize(UserType.MONSERA_ADMIN, UserType.EMPLOYEE)(getHandler);
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);