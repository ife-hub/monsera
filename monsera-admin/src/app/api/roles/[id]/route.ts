import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/roles/:id
 * All authenticated users
 */
async function getHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  const role = await prisma.role.findUnique({
    where: { id },
    include: { employees: { select: { id: true, userId: true } } }
  });

  if (!role) return NextResponse.json({ success: false, message: 'Role not found' }, { status: 404, headers: getCorsHeaders(request.headers.get('origin')) });

  return NextResponse.json({ success: true, data: role });
}

/**
 * PUT /api/roles/:id
 * Only MONSERA_ADMIN
 */
async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin'))   });

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

    const updated = await prisma.role.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description && { description }),
        ...(canViewTransactions !== undefined && { canViewTransactions }),
        ...(canManageTransactions !== undefined && { canManageTransactions }),
        ...(canViewUsers !== undefined && { canViewUsers }),
        ...(canManageUsers !== undefined && { canManageUsers }),
        ...(canBlacklistUsers !== undefined && { canBlacklistUsers }),
        ...(canActivateUsers !== undefined && { canActivateUsers }),
        ...(canViewScoringEngine !== undefined && { canViewScoringEngine }),
        ...(canEditThreshold !== undefined && { canEditThreshold }),
        ...(canValidateLoans !== undefined && { canValidateLoans }),
      },
    });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Updated role ${updated.name}`,
      },
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Update role error:', error);
    if (error.code === 'P2002') {
      return NextResponse.json({ success: false, message: 'Role name already exists' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    }
    return NextResponse.json({ success: false, message: 'Failed to update role' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

/**
 * DELETE /api/roles/:id
 * Only MONSERA_ADMIN
 */
async function deleteHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  try {
    await prisma.role.delete({ where: { id } });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Deleted role ID ${id}`,
      },
    });

    return NextResponse.json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete role error:', error);
    return NextResponse.json({ success: false, message: 'Failed to delete role' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

// Exports with auth
// Staff only: internal configuration / meter and partner data.
export const GET = authorize(UserType.MONSERA_ADMIN, UserType.EMPLOYEE)(getHandler);
export const PUT = authorize(UserType.MONSERA_ADMIN)(putHandler);
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler);