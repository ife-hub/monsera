import { NextResponse } from '../../../../lib/next-server';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';
import { customerScopeFor } from '../../../../lib/access-scope';


export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/customers/:id
 * All authenticated users
 */
async function getHandler(
  request: AuthenticatedRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  
  if (isNaN(id)) {
    return NextResponse.json(
      { success: false, message: 'Invalid ID' },
      { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }

  // Partners can only open customers who have taken a loan through them;
  // anything else reads as not found rather than leaking that it exists.
  const customer = await prisma.customer.findFirst({
    where: { id, ...(await customerScopeFor(request.user!)) },
  });

  if (!customer) {
    return NextResponse.json(
      { success: false, message: 'Customer not found' },
      { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }

  return NextResponse.json({ success: true, data: customer }, { headers: getCorsHeaders(request.headers.get('origin')) });
}

/**
 * PUT /api/customers/:id
 * Only EMPLOYEE & SYSTEM_ADMIN
 */
async function putHandler(
  request: AuthenticatedRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  
  if (isNaN(id)) {
    return NextResponse.json(
      { success: false, message: 'Invalid ID' },
      { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }

  try {
    const body = await request.json();
    const isAdmin = request.user!.userType === UserType.MONSERA_ADMIN;
    // Partners may only edit customers who have borrowed through them.
    const visible = await prisma.customer.findFirst({
      where: { id, ...(await customerScopeFor(request.user!)) },
      select: { id: true },
    });
    if (!visible) {
      return NextResponse.json(
        { success: false, message: 'Customer not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // The field was renamed meterNumber -> meterToken; accept the old name too.
    const meterToken = body.meterToken ?? body.meterNumber;

    // `outstanding` is derived from the obligation ledger. Letting partners
    // write it directly let any aggregator wipe a customer's debt.
    if (body.outstanding !== undefined && !isAdmin) {
      return NextResponse.json(
        { success: false, message: 'Only Monsera admins can change outstanding balances' },
        { status: 403, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    const updated = await prisma.customer.update({
      where: { id },
      data: {
        ...(meterToken !== undefined && { meterToken }),
        ...(body.riskLevel !== undefined && { riskLevel: body.riskLevel }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.state !== undefined && { state: body.state }),
        ...(body.outstanding !== undefined && {
          outstanding: new Prisma.Decimal(body.outstanding),
        }),
        ...(body.lastInteraction !== undefined && {
          lastInteraction: new Date(body.lastInteraction),
        }),
        ...(body.dateAdded !== undefined && {
          dateAdded: new Date(body.dateAdded),
        }),
      },
    });

    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Updated customer ${updated.meterToken}`,
      },
    });

    return NextResponse.json(
      { success: true, data: updated },
      { headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error: any) {
    console.error('Update customer error:', error);

    if (error.code === 'P2002') {
      return NextResponse.json(
        { success: false, message: 'Meter number already exists' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    return NextResponse.json(
      { success: false, message: 'Failed to update customer' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

/**
 * DELETE /api/customers/:id
 * Only SYSTEM_ADMIN
 */
async function deleteHandler(
  request: AuthenticatedRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  
  if (isNaN(id)) {
    return NextResponse.json(
      { success: false, message: 'Invalid ID' },
      { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }

  try {
    await prisma.customer.delete({ where: { id } });

    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Deleted customer ID ${id}`,
      },
    });

    return NextResponse.json(
      { success: true, message: 'Deleted successfully' },
      { headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Delete customer error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to delete customer' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

// Exports with auth
export const GET = authenticate(getHandler);
export const PUT = authorize(UserType.MONSERA_ADMIN, UserType.AGGREGATOR, UserType.DISCO_ADMIN)(putHandler);
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler);