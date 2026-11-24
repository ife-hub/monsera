// app/api/meter-state/[id]/route.ts
import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { handleOptions } from '../../../../lib/cors';

// CORS preflight — browsers send this before any request carrying Authorization.
export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/meter-state/:id
 * Accessible by all authenticated users
 */
async function getHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) {
    return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400 });
  }

  const data = await prisma.meter_State.findUnique({
    where: { id },
  });

  if (!data) {
    return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data });
}

/**
 * PUT /api/meter-state/:id
 * Accessible by EMPLOYEE and SYSTEM_ADMIN only
 */
async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) {
    return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400 });
  }

  try {
    const { date, meterNumber, state } = await request.json();

    const updated = await prisma.meter_State.update({
      where: { id },
      data: {
        ...(date && { date: new Date(date) }),
        ...(meterNumber && { meterNumber }),
        ...(state && { state }),
      },
    });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Updated meter state ID ${id}`
      }
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error('Update meter state error:', error);
    return NextResponse.json({ success: false, message: 'Failed to update meter state' }, { status: 500 });
  }
}

/**
 * DELETE /api/meter-state/:id
 * Accessible by SYSTEM_ADMIN only
 */
async function deleteHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) {
    return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400 });
  }

  try {
    await prisma.meter_State.delete({ where: { id } });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Deleted meter state ID ${id}`
      }
    });

    return NextResponse.json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete meter state error:', error);
    return NextResponse.json({ success: false, message: 'Failed to delete meter state' }, { status: 500 });
  }
}

// --- Export handlers with authentication/authorization ---
// Staff only: internal configuration / meter and partner data.
export const GET = authorize(UserType.MONSERA_ADMIN, UserType.EMPLOYEE)(getHandler);
export const PUT = authorize(UserType.EMPLOYEE, UserType.MONSERA_ADMIN)(putHandler); // EMPLOYEE & SYSTEM_ADMIN
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler); // Only SYSTEM_ADMIN