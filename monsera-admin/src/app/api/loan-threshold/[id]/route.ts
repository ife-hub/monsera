import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/loan-threshold/:id
 * All authenticated users
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
    const data = await prisma.loan_Threshold.findUnique({ where: { id } });
    
    if (!data) {
      return NextResponse.json(
        { success: false, message: 'Not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    return NextResponse.json(
      { success: true, data },
      { status: 200, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Get loan threshold error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch loan threshold' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

/**
 * PUT /api/loan-threshold/:id
 * Only EMPLOYEE & MONSERA_ADMIN
 */
async function putHandler(
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
    const { minimum, maximum } = await request.json();

    const updated = await prisma.loan_Threshold.update({
      where: { id },
      data: {
        ...(minimum !== undefined && { minimum: new Prisma.Decimal(minimum) }),
        ...(maximum !== undefined && { maximum: new Prisma.Decimal(maximum) }),
      },
    });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Updated loan threshold ${id}`,
      },
    });

    return NextResponse.json(
      { success: true, data: updated },
      { status: 200, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Update loan threshold error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to update loan threshold' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

/**
 * DELETE /api/loan-threshold/:id
 * Only MONSERA_ADMIN
 */
async function deleteHandler(
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
    await prisma.loan_Threshold.delete({ where: { id } });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Deleted loan threshold ${id}`,
      },
    });

    return NextResponse.json(
      { success: true, message: 'Deleted successfully' },
      { status: 200, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Delete loan threshold error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to delete loan threshold' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

// Exports with auth
// Staff only: internal configuration / meter and partner data.
export const GET = authorize(UserType.MONSERA_ADMIN, UserType.EMPLOYEE)(getHandler);
export const PUT = authorize(UserType.EMPLOYEE, UserType.MONSERA_ADMIN)(putHandler);
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler);