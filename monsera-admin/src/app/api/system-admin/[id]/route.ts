import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import { safeUserSelect } from '../../../../lib/safe-select';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { handleOptions } from '../../../../lib/cors';

// CORS preflight — browsers send this before any request carrying Authorization.
export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/system-admin/:id
 * Only MONSERA_ADMIN
 */
async function getHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400 });

  const admin = await prisma.systemAdmin.findUnique({
    where: { id },
    include: { user: { select: safeUserSelect } },
  });

  if (!admin) return NextResponse.json({ success: false, message: 'SystemAdmin not found' }, { status: 404 });

  return NextResponse.json({ success: true, data: admin });
}

/**
 * PUT /api/system-admin/:id
 * Only MONSERA_ADMIN
 */
async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400 });

  try {
    const { adminType, permissions } = await request.json();

    const updated = await prisma.systemAdmin.update({
      where: { id },
      data: {
        ...(adminType && { adminType }),
        ...(permissions && { permissions }),
      },
      include: { user: { select: safeUserSelect } },
    });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Updated system admin ID ${id}`,
      },
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error('Update system admin error:', error);
    return NextResponse.json({ success: false, message: 'Failed to update system admin' }, { status: 500 });
  }
}

/**
 * DELETE /api/system-admin/:id
 * Only MONSERA_ADMIN
 */
async function deleteHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400 });

  try {
    await prisma.systemAdmin.delete({ where: { id } });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Deleted system admin ID ${id}`,
      },
    });

    return NextResponse.json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete system admin error:', error);
    return NextResponse.json({ success: false, message: 'Failed to delete system admin' }, { status: 500 });
  }
}

// Exports with auth
export const GET = authorize(UserType.MONSERA_ADMIN)(getHandler);
export const PUT = authorize(UserType.MONSERA_ADMIN)(putHandler);
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler);