import { NextResponse } from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

async function getHandler(request: AuthenticatedRequest) {
  try {
    const data = await prisma.loan_Threshold.findMany({
      orderBy: { id: 'asc' },
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Fetch loan threshold error:', error);
    return NextResponse.json({ success: false, message: 'Failed to fetch loan thresholds' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) } );
  }
}

/**
 * POST /api/loan-threshold
 * EMPLOYEE & MONSERA_ADMIN
 */
async function postHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  try {
    // This endpoint previously wrote to Float_Ledger (a copy-paste of the
    // float-ledger handler). It now creates a Loan_Threshold row as intended.
    const { minimum, maximum } = await request.json();

    const min = Number(minimum);
    const max = Number(maximum);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= 0) {
      return NextResponse.json({ success: false, message: 'minimum and maximum must be non-negative numbers' }, { status: 400, headers });
    }
    if (min >= max) {
      return NextResponse.json({ success: false, message: 'minimum must be less than maximum' }, { status: 400, headers });
    }

    const created = await prisma.loan_Threshold.create({
      data: {
        minimum: new Prisma.Decimal(minimum),
        maximum: new Prisma.Decimal(maximum),
      },
    });

    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Created loan threshold ${created.id}: min ${minimum}, max ${maximum}`,
      },
    });

    return NextResponse.json({ success: true, data: created }, { status: 201, headers });
  } catch (error) {
    console.error('Create loan threshold error:', error);
    return NextResponse.json({ success: false, message: 'Failed to create loan threshold' }, { status: 500, headers });
  }
}


// Exports with auth
// Staff only: internal configuration / meter and partner data.
export const GET = authorize(UserType.MONSERA_ADMIN, UserType.EMPLOYEE)(getHandler);
export const POST = authorize(UserType.EMPLOYEE, UserType.MONSERA_ADMIN)(postHandler);