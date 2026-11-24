import { NextResponse } from '../../../lib/next-server';
import { safeUserSelect } from '../../../lib/safe-select';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType, Prisma } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/employees
 * Only MONSERA_ADMIN & DISCO_ADMIN can view all employees
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const employees = await prisma.employee.findMany({
      include: { role: true, user: { select: safeUserSelect } },
      orderBy: { name: 'asc' },
    });

    return NextResponse.json({ success: true, data: employees }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Fetch employees error:', error);
    return NextResponse.json({ success: false, message: 'Failed to fetch employees' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

/**
 * POST /api/employees
 * Only MONSERA_ADMIN can create employees
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const { name, emailAddress, phoneNumber, gender, roleId, status, password } = await request.json();
    if (!name || !emailAddress || !phoneNumber || !gender || !roleId || !password) {
      return NextResponse.json({ success: false, message: 'Missing required fields' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    }

    // User + employee rows are created atomically.
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 10);

    const employee = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email: emailAddress,
          passwordHash,
          userType: UserType.EMPLOYEE,
        },
      });

      return tx.employee.create({
        data: {
          userId: user.id,
          name,
          emailAddress,
          phoneNumber,
          gender,
          status: status || 'active',
          roleId,
        },
        include: { role: true, user: { select: safeUserSelect } },
      });
    });

    return NextResponse.json({ success: true, data: employee }, { status: 201, headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error: any) {
    console.error('Create employee error:', error);
    if (error.code === 'P2002') {
      return NextResponse.json({ success: false, message: 'Email or phone number already exists' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });
    }
    return NextResponse.json({ success: false, message: 'Failed to create employee' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

// Exports with auth
export const GET = authorize(UserType.MONSERA_ADMIN)(getHandler);
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);