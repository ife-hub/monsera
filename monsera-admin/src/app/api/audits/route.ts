// app/api/audits/route.ts
import { NextResponse } from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/audits
 * All authenticated users can view
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const employeeName = url.searchParams.get('employeeName');
    const state = url.searchParams.get('state');
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '10');

    const skip = (page - 1) * limit;

    // Monsera staff can read the whole trail; partners only their own entries.
    const isStaff =
      request.user!.userType === UserType.MONSERA_ADMIN || request.user!.userType === UserType.EMPLOYEE;
    const userFilter = isStaff
      ? (userId ? { userId: Number(userId) } : {})
      : { userId: request.user!.userId };

    const audits = await prisma.audit.findMany({
      where: {
        ...userFilter,
        ...(employeeName && { employeeName: { contains: employeeName, mode: 'insensitive' } }),
        ...(state && { state }),
      },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { date: 'desc' },
      skip,
      take: limit,
    });

    return NextResponse.json({ success: true, data: audits }, { status: 200, headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Fetch audits error:', error);
    return NextResponse.json({ success: false, message: 'Failed to fetch audits' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

/**
 * POST /api/audits
 * Create new audit log (blacklist or activate meter)
 * Only EMPLOYEE & MONSERA_ADMIN
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const { meterId, action, reason } = await request.json();

    if (!meterId || !action) {
      return NextResponse.json(
        { success: false, message: 'Missing required fields: meterId and action' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    if (!['blacklist', 'activate'].includes(action.toLowerCase())) {
      return NextResponse.json(
        { success: false, message: 'Invalid action. Must be "blacklist" or "activate"' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    const isBlacklist = action.toLowerCase() === 'blacklist';
    const state = isBlacklist ? 'inactive' : 'active';
    const activity = isBlacklist
      ? `Blacklisted meter no. ${meterId}${reason ? ` for ${reason}` : ''}`
      : `Activated meter no ${meterId}`;

    // Blacklisting used to only write an audit row; the customer could still
    // borrow. Now it sets Customer.status, which the debit handler enforces.
    const customerUpdate = await prisma.customer.updateMany({
      where: { meterToken: meterId },
      data: { status: isBlacklist ? 'blacklisted' : 'active' },
    });

    const audit = await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity,
        meterId,
        state,
        reason: isBlacklist ? reason || 'Manual Action' : 'N/A',
        date: new Date(),
      },
    });

    return NextResponse.json(
      { success: true, data: audit, customerUpdated: customerUpdate.count > 0 },
      { status: 201, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Create audit error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to create audit log' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

// Exports with auth
export const GET = authenticate(getHandler);
// Blacklisting/activating a meter changes lending eligibility, so it is a Monsera staff action.
export const POST = authorize(UserType.EMPLOYEE, UserType.MONSERA_ADMIN)(postHandler);