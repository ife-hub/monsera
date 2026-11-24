import { NextResponse } from '../../../lib/next-server';
import  prisma  from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/users
 * Accessible by MONSERA_ADMIN and EMPLOYEE
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
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

    return NextResponse.json({ success: true, data: users });
  } catch (error) {
    console.error('Fetch users error:', error);
    return NextResponse.json({ success: false, message: 'Failed to fetch users' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

/**
 * POST /api/users
 * Only MONSERA_ADMIN
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const { email, name, password, userType, isActive } = await request.json();

    if (!email || !name || !password || !userType) {
      return NextResponse.json({ success: false, message: 'Missing required fields' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    const created = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        userType,
        isActive: isActive ?? true,
      },
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
        activity: `Created user ${created.email} (${created.userType})`,
      },
    });

    return NextResponse.json({ success: true, data: created }, { status: 201, headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error: any) {
    console.error('Create user error:', error);
    if (error.code === 'P2002') {
      return NextResponse.json({ success: false, message: 'Email already exists' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    }
    return NextResponse.json({ success: false, message: 'Failed to create user' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

// Export with auth
export const GET = authorize(UserType.EMPLOYEE, UserType.MONSERA_ADMIN)(getHandler); // EMPLOYEE and MONSERA_ADMIN
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler); // Only MONSERA_ADMIN