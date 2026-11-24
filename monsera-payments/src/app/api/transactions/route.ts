import { NextResponse } from '../../../lib/next-server';
import { safeAggregatorSelect, safeDiscoSelect } from '../../../lib/safe-select';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';
import { transactionScopeFor } from '../../../lib/access-scope';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/transactions
 * All authenticated users
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, parseInt(searchParams.get('limit') || '50'));
    const skip = (page - 1) * limit;

    // Partners only ever see their own transactions; staff see everything.
    const where = await transactionScopeFor(request.user!);

    const [transactions, total] = await Promise.all([
      prisma.transactions.findMany({
        where,
        orderBy: { date: 'desc' },
        skip,
        take: limit,
        include: { aggregator: { select: safeAggregatorSelect }, customer: true, discoAdmin: { select: safeDiscoSelect } },
      }),
      prisma.transactions.count({ where }),
    ]);

    return NextResponse.json(
      {
        success: true,
        data: transactions,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: skip + limit < total,
        },
      },
      {
        headers: {
          ...getCorsHeaders(request.headers.get('origin')),
          'Cache-Control': 'private, max-age=10',
        },
      }
    );
  } catch (error) {
    console.error('Fetch transactions error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch transactions' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

/**
 * POST /api/transactions
 * Only EMPLOYEE & SYSTEM_ADMIN
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const {
      date,
      transactionId,
      aggregatorId,
      customerId,
      discoAdminId,
      branch,
      amount,
      transactionType,
      transactionStatus,
      paymentStatus,
    } = await request.json();

    if (
      !date ||
      !transactionId ||
      !aggregatorId ||
      !customerId ||
      !discoAdminId ||
      !branch ||
      amount === undefined ||
      !transactionType ||
      !transactionStatus ||
      !paymentStatus
    ) {
      return NextResponse.json(
        { success: false, message: 'Missing required fields' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    const created = await prisma.transactions.create({
      data: {
        date: new Date(date),
        transactionId,
        aggregatorId,
        customerId,
        discoAdminId,
        branch,
        amount: new Prisma.Decimal(amount),
        transactionType,
        transactionStatus,
        paymentStatus,
      },
    });

    // Audit log
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Created transaction ${transactionId}`,
      },
    });

    return NextResponse.json(
      { success: true, data: created },
      { status: 201, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error: any) {
    console.error('Create transaction error:', error);
    if (error.code === 'P2002') {
      return NextResponse.json(
        { success: false, message: 'Transaction ID already exists' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }
    return NextResponse.json(
      { success: false, message: 'Failed to create transaction' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

/**
 * @swagger
 * /api/transactions:
 *   get:
 *     summary: List transactions
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of records per page (max 100)
 *     responses:
 *       200:
 *         description: Paginated list of transactions.
 *       500:
 *         description: Failed to fetch transactions.
 */
export const GET = authenticate(getHandler);

/**
 * @swagger
 * /api/transactions:
 *   post:
 *     summary: Create a new transaction
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [date, transactionId, aggregatorId, customerId, discoAdminId, branch, amount, transactionType, transactionStatus, paymentStatus]
 *             properties:
 *               date:
 *                 type: string
 *                 format: date-time
 *               transactionId:
 *                 type: string
 *               aggregatorId:
 *                 type: integer
 *               customerId:
 *                 type: integer
 *               discoAdminId:
 *                 type: integer
 *               branch:
 *                 type: string
 *               amount:
 *                 type: number
 *               transactionType:
 *                 type: string
 *               transactionStatus:
 *                 type: string
 *               paymentStatus:
 *                 type: string
 *     responses:
 *       201:
 *         description: Transaction created successfully.
 *       400:
 *         description: Missing required fields, or transaction ID already exists.
 *       500:
 *         description: Failed to create transaction.
 */
// Manual ledger entries bypass every disbursement/recovery control, so only
// Monsera admins may create them. Partners use /transactions/debit and /credit.
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);