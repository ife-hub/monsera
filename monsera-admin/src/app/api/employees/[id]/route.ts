import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import { safeUserSelect } from '../../../../lib/safe-select';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType, Prisma } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/employees/:id
 */
async function getHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid employee ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  const employee = await prisma.employee.findUnique({
    where: { id },
    include: { role: true, user: { select: safeUserSelect } },
  });

  if (!employee) return NextResponse.json({ success: false, message: 'Employee not found' }, { status: 404, headers: getCorsHeaders(request.headers.get('origin')) });
  return NextResponse.json({ success: true, data: employee }, { headers: getCorsHeaders(request.headers.get('origin')) });
}

/**
 * PUT /api/employees/:id
 */
async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid employee ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  try {
    const { name, emailAddress, phoneNumber, gender, roleId, status, password } = await request.json();

    const updateData: any = {
      ...(name && { name }),
      ...(emailAddress && { emailAddress }),
      ...(phoneNumber && { phoneNumber }),
      ...(gender && { gender }),
      ...(roleId && { roleId }),
      ...(status && { status }),
    };

    const employee = await prisma.employee.update({
      where: { id },
      data: updateData,
      include: { role: true, user: { select: safeUserSelect } },
    });

    // Update linked user email/password if provided
    if (password || emailAddress || name) {
      const userUpdate: any = {};
      if (emailAddress) userUpdate.email = emailAddress;
      if (name) userUpdate.name = name;
      if (password) {
        const bcrypt = await import('bcryptjs');
        userUpdate.passwordHash = await bcrypt.hash(password, 10);
        userUpdate.passwordChangedAt = new Date(); // signs the employee out everywhere
      }

      await prisma.user.update({
        where: { id: employee.userId! },
        data: userUpdate,
      });
    }

    return NextResponse.json({ success: true, data: employee }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error: any) {
    console.error('Update employee error:', error);
    if (error.code === 'P2002') {
      return NextResponse.json({ success: false, message: 'Email or phone number already exists' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    }
    return NextResponse.json({ success: false, message: 'Failed to update employee' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

/**
 * DELETE /api/employees/:id
 * Only MONSERA_ADMIN
 */
async function deleteHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid employee ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  try {
    const employee = await prisma.employee.delete({ where: { id } });

    // Optionally delete linked user
    if (employee.userId) {
      await prisma.user.delete({ where: { id: employee.userId } });
    }

    return NextResponse.json({ success: true, message: 'Employee deleted successfully' }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error: any) {
    // Spec §10: audit rows are append-only, so a user with audit history
    // cannot be deleted (it would rewrite their entries). Deactivate instead.
    if (String(error?.message ?? '').includes('append-only')) {
      return NextResponse.json(
        { success: false, message: 'This account has audit history and cannot be deleted. Deactivate it instead.' },
        { status: 409 }
      );
    }
    console.error('Delete employee error:', error);
    return NextResponse.json({ success: false, message: 'Failed to delete employee' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

// Exports with auth
export const GET = authorize(UserType.MONSERA_ADMIN)(getHandler);
export const PUT = authorize(UserType.MONSERA_ADMIN)(putHandler);
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler);