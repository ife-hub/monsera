// app/api/financeHouse/float-ledger/route.ts
import { NextResponse } from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/financeHouse/float-ledger
 * Finance house users can view their own float ledger entries
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '10');
    const skip = (page - 1) * limit;

    // Get the finance house associated with the current user
    const financeHouse = await prisma.financeHouse.findUnique({
      where: { userId: request.user!.userId },
    });

    if (!financeHouse) {
      return NextResponse.json(
        { success: false, message: 'Finance house not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Fetch float ledger entries for this finance house
    const [floatLedgers, total] = await Promise.all([
      prisma.float_Ledger.findMany({
        where: { financeHouseId: financeHouse.id },
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
      prisma.float_Ledger.count({
        where: { financeHouseId: financeHouse.id },
      }),
    ]);

    return NextResponse.json(
      {
        success: true,
        data: floatLedgers,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      { headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Fetch float ledger error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch float ledger entries' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

/**
 * POST /api/financeHouse/float-ledger
 * Finance house users can create credit entries only
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const { amount, referenceId, attachmentUrl } = await request.json();

    if (!amount || !referenceId) {
      return NextResponse.json(
        { success: false, message: 'Amount and reference ID are required' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Validate amount is positive
    const amountDecimal = parseFloat(amount);
    if (isNaN(amountDecimal) || amountDecimal <= 0) {
      return NextResponse.json(
        { success: false, message: 'Amount must be a positive number' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Get the finance house associated with the current user
    const financeHouse = await prisma.financeHouse.findUnique({
      where: { userId: request.user!.userId },
    });

    if (!financeHouse) {
      return NextResponse.json(
        { success: false, message: 'Finance house not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Check if reference ID already exists
    const existingEntry = await prisma.float_Ledger.findFirst({
      where: { referenceId },
    });

    if (existingEntry) {
      return NextResponse.json(
        { success: false, message: 'Reference ID already exists' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Get the current float balance (most recent entry)
    const lastEntry = await prisma.float_Ledger.findFirst({
      orderBy: { date: 'desc' },
    });

    const currentBalance = lastEntry
      ? parseFloat(lastEntry.currentFloatBalance.toString())
      : 0;

    // Calculate new balance (Credit adds to balance)
    const newBalance = currentBalance + amountDecimal;

    // Create the float ledger entry
    const floatLedger = await prisma.float_Ledger.create({
      data: {
        date: new Date(),
        referenceId,
        amount: amountDecimal,
        type: 'Credit', // Always Credit for finance house
        currentFloatBalance: newBalance,
        attachmentUrl: attachmentUrl || null,
        financeHouseId: financeHouse.id,
      },
    });

    // Create audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: financeHouse.name,
        emailAddress: request.user!.email,
        activity: `Added float ledger credit entry: ${referenceId} - ₦${amountDecimal.toLocaleString()}`,
      },
    });

    return NextResponse.json(
      { success: true, data: floatLedger },
      { status: 201, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error: any) {
    console.error('Create float ledger error:', error);
    
    if (error.code === 'P2002') {
      return NextResponse.json(
        { success: false, message: 'Reference ID already exists' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    return NextResponse.json(
      { success: false, message: 'Failed to create float ledger entry' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

export const GET = authenticate(getHandler);
export const POST = authorize(UserType.FINANCE_HOUSE)(postHandler);