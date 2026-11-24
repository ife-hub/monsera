import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { handleOptions } from '../../../../lib/cors';

// CORS preflight — browsers send this before any request carrying Authorization.
export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/users/:id
 * EMPLOYEE and MONSERA_ADMIN
 */
async function getHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      userType: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) return NextResponse.json({ success: false, message: 'User not found' }, { status: 404 });

  return NextResponse.json({ success: true, data: user });
}

/**
 * PUT /api/users/:id
 * Only MONSERA_ADMIN
 */
async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400 });

  try {
    const { name, email, password, userType, isActive } = await request.json();

    const data: any = {};
    if (name) data.name = name;
    if (email) data.email = email;
    if (userType) data.userType = userType;
    if (isActive !== undefined) data.isActive = isActive;
    if (password) {
      data.passwordHash = await bcrypt.hash(password, 10);
      data.passwordChangedAt = new Date(); // signs the user out everywhere
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        userType: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Updated user ${updated.email} (${updated.userType})`,
      },
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Update user error:', error);
    if (error.code === 'P2002') {
      return NextResponse.json({ success: false, message: 'Email already exists' }, { status: 400 });
    }
    return NextResponse.json({ success: false, message: 'Failed to update user' }, { status: 500 });
  }
}

/**
 * DELETE /api/users/:id
 * Only MONSERA_ADMIN
 */
async function deleteHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400 });

  try {
    await prisma.user.delete({ where: { id } });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Deleted user ID ${id}`,
      },
    });

    return NextResponse.json({ success: true, message: 'Deleted successfully' });
  } catch (error: any) {
    // Spec §10: audit rows are append-only, so a user with audit history
    // cannot be deleted (it would rewrite their entries). Deactivate instead.
    if (String(error?.message ?? '').includes('append-only')) {
      return NextResponse.json(
        { success: false, message: 'This account has audit history and cannot be deleted. Deactivate it instead.' },
        { status: 409 }
      );
    }
    console.error('Delete user error:', error);
    return NextResponse.json({ success: false, message: 'Failed to delete user' }, { status: 500 });
  }
}

// Exports with auth
export const GET = authorize(UserType.EMPLOYEE, UserType.MONSERA_ADMIN)(getHandler); // EMPLOYEE & MONSERA_ADMIN
export const PUT = authorize(UserType.MONSERA_ADMIN)(putHandler); // MONSERA_ADMIN only
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler); // MONSERA_ADMIN only