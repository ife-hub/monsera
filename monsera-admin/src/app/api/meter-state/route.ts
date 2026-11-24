// app/api/meter-state/route.ts
import { NextRequest, NextResponse } from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import { handleOptions } from '../../../lib/cors';

// CORS preflight — browsers send this before any request carrying Authorization.
export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/meter-state
 * Fetch all meter states
 * Accessible by: All authenticated users
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const data = await prisma.meter_State.findMany({
      orderBy: { date: 'desc' },
    });

    return NextResponse.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Fetch meter states error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch meter states' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/meter-state
 * Create a meter state
 * Accessible by: EMPLOYEE and SYSTEM_ADMIN only
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const { date, meterToken, state } = await request.json();

    if (!date || !meterToken || !state) {
      return NextResponse.json(
        { success: false, message: 'Missing required fields' },
        { status: 400 }
      );
    }

    const created = await prisma.meter_State.create({
      data: {
        date: new Date(date),
        meterToken,
        state,
      },
    });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Created meter state for meter ${meterToken}`
      }
    });

    return NextResponse.json({
      success: true,
      data: created
    }, { status: 201 });
  } catch (error) {
    console.error('Create meter state error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to create meter state' },
      { status: 500 }
    );
  }
}

// Export with authentication
// GET: All authenticated users can read
// Staff only: internal configuration / meter and partner data.
export const GET = authorize(UserType.MONSERA_ADMIN, UserType.EMPLOYEE)(getHandler);

// POST: Only EMPLOYEE and SYSTEM_ADMIN can create
export const POST = authorize(UserType.EMPLOYEE, UserType.MONSERA_ADMIN)(postHandler);