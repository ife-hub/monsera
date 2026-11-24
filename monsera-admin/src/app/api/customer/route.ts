import { NextResponse } from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';
import { customerScopeFor } from '../../../lib/access-scope';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/customer
 * All authenticated users
 * Query params:
 * - aggregatorId: Filter customer by azzzggregator ID
 * - status: Filter by customer status
 * - state: Filter by customer state
 * - riskLevel: Filter by risk level
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const aggregatorId = searchParams.get('aggregatorId');
    const discoAdminId = searchParams.get('discoAdminId');
    const status = searchParams.get('status');
    const state = searchParams.get('state');
    const riskLevel = searchParams.get('riskLevel');

    // Build where clause. Partners only ever see customers who have taken a
    // loan through them; staff see everyone.
    const where: any = { AND: [await customerScopeFor(request.user!)] };

    // Filter by aggregator if provided
    if (aggregatorId) {
      where.customerAggregators = {
        some: {
          aggregatorId: parseInt(aggregatorId),
          isActive: true,
        },
      };
    }

    if (discoAdminId) {
      where.customerDiscoAdmins = {
        some: {
          discoAdminId: parseInt(discoAdminId),
          isActive: true,
        },
      };
    }

    // Additional filters
    if (status) where.status = status;
    if (state) where.state = state;
    if (riskLevel) where.riskLevel = riskLevel;

    // Define include separately with proper typing
    const includeConfig = {
      customerAggregators: {
        where: { isActive: true },
        include: {
          aggregator: {
            select: {
              id: true,
              name: true,
              mail: true,
              logoUrl: true,
            },
          },
        },
      },
      customerDiscoAdmins: {
        where: { isActive: true },
        include: {
          discoAdmin: {
            select: {
              id: true,
              name: true,
              mail: true,
              logoUrl: true,
            },
          },
        },
      },
      transactions: {
        take: 5,
        orderBy: { createdAt: 'desc' as const },
        select: {
          id: true,
          date: true,
          transactionId: true,
          amount: true,
          transactionType: true,
          transactionStatus: true,
          paymentStatus: true,
        },
      },
    };

    // Optional pagination: pass ?page=&limit= to page through large lists.
    // Without them the full list is returned, as before.
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');
    const paginate = pageParam !== null || limitParam !== null;
    const page = Math.max(1, parseInt(pageParam || '1') || 1);
    const limit = Math.min(500, Math.max(1, parseInt(limitParam || '50') || 50));

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        include: includeConfig,
        orderBy: { dateAdded: 'desc' },
        ...(paginate && { skip: (page - 1) * limit, take: limit }),
      }),
      paginate ? prisma.customer.count({ where }) : Promise.resolve(null),
    ]);

    return NextResponse.json(
      {
        success: true,
        data: customers,
        ...(paginate && { pagination: { page, limit, total, totalPages: Math.ceil((total ?? 0) / limit) } }),
      },
      { status: 200, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Fetch customers error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch customers' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

/**
 * POST /api/customer
 * Only EMPLOYEE & MONSERA_ADMIN
 * Creates a new customer and optionally associates with aggregator(s)
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    const body = await request.json();
    const {
      lastInteraction,
      riskLevel,
      outstanding,
      status,
      state,
      dateAdded,
      aggregatorIds,
    } = body;
    // The column was renamed meterNumber -> meterToken; accept either name.
    const meterToken = body.meterToken ?? body.meterNumber;

    if (!meterToken || !riskLevel || outstanding === undefined || !status || !state) {
      return NextResponse.json(
        { success: false, message: 'Missing required fields' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Validate aggregator IDs if provided
    if (aggregatorIds && Array.isArray(aggregatorIds) && aggregatorIds.length > 0) {
      const validAggregators = await prisma.aggregator.findMany({
        where: { id: { in: aggregatorIds } },
        select: { id: true },
      });

      if (validAggregators.length !== aggregatorIds.length) {
        return NextResponse.json(
          { success: false, message: 'One or more invalid aggregator IDs' },
          { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
        );
      }
    }

    // Build the create data object
    const createData: any = {
      meterToken,
      riskLevel,
      outstanding: new Prisma.Decimal(outstanding),
      status,
      state,
      lastInteraction: lastInteraction ? new Date(lastInteraction) : new Date(),
      dateAdded: dateAdded ? new Date(dateAdded) : new Date(),
    };

    // Add aggregator relationships if provided
    if (aggregatorIds && Array.isArray(aggregatorIds) && aggregatorIds.length > 0) {
      createData.customerAggregators = {
        create: aggregatorIds.map((aggId: number) => ({
          aggregatorId: aggId,
          isActive: true,
        })),
      };
    }

    // Define include separately
    const includeConfig = {
      customerAggregators: {
        include: {
          aggregator: {
            select: {
              id: true,
              name: true,
              mail: true,
            },
          },
        },
      },
    };

    const created = await prisma.customer.create({
      data: createData,
      include: includeConfig,
    });

    // Audit log (employee/admin action)
    const userName = (request.user as any)?.name || request.user!.email;
    
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: userName,
        emailAddress: request.user!.email,
        activity: `Created customer ${meterToken}`,
        meterId: meterToken,
        state: 'active',
        reason: 'Customer creation',
      },
    });

    return NextResponse.json(
      { success: true, data: created },
      { status: 201, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error: any) {
    console.error('Create customer error:', error);

    if (error.code === 'P2002') {
      return NextResponse.json(
        { success: false, message: 'Meter number already exists' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    return NextResponse.json(
      { success: false, message: 'Failed to create customer' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

/**
 * PUT /api/customers?id={customerId}
 * Update customer and manage aggregator associations
 */
async function putHandler(request: AuthenticatedRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get('id');

    if (!customerId) {
      return NextResponse.json(
        { success: false, message: 'Customer ID is required' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    const body = await request.json();
    const {
      riskLevel,
      outstanding,
      status,
      state,
      aggregatorIds,
      addAggregatorIds,
      removeAggregatorIds,
    } = body;
    const meterToken = body.meterToken ?? body.meterNumber;

    if (outstanding !== undefined && request.user!.userType !== UserType.MONSERA_ADMIN) {
      return NextResponse.json(
        { success: false, message: 'Only Monsera admins can change outstanding balances' },
        { status: 403, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Check if customer exists
    // Partners may only edit customers who have borrowed through them.
    const existingCustomer = await prisma.customer.findFirst({
      where: { id: parseInt(customerId), ...(await customerScopeFor(request.user!)) },
    });

    if (!existingCustomer) {
      return NextResponse.json(
        { success: false, message: 'Customer not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Build update data
    const updateData: any = {
      lastInteraction: new Date(),
    };

    if (meterToken !== undefined) updateData.meterToken = meterToken;
    if (riskLevel !== undefined) updateData.riskLevel = riskLevel;
    if (outstanding !== undefined) updateData.outstanding = new Prisma.Decimal(outstanding);
    if (status !== undefined) updateData.status = status;
    if (state !== undefined) updateData.state = state;

    // Handle aggregator associations
    if (aggregatorIds && Array.isArray(aggregatorIds)) {
      // Replace all aggregator associations
      updateData.customerAggregators = {
        deleteMany: {},
        create: aggregatorIds.map((aggId: number) => ({
          aggregatorId: aggId,
          isActive: true,
        })),
      };
    } else {
      // Selective add/remove
      const aggregatorOperations: any = {};

      if (removeAggregatorIds && Array.isArray(removeAggregatorIds) && removeAggregatorIds.length > 0) {
        aggregatorOperations.deleteMany = {
          aggregatorId: { in: removeAggregatorIds },
        };
      }

      if (addAggregatorIds && Array.isArray(addAggregatorIds) && addAggregatorIds.length > 0) {
        aggregatorOperations.create = addAggregatorIds.map((aggId: number) => ({
          aggregatorId: aggId,
          isActive: true,
        }));
      }

      if (Object.keys(aggregatorOperations).length > 0) {
        updateData.customerAggregators = aggregatorOperations;
      }
    }

    // Define include separately
    const includeConfig = {
      customerAggregators: {
        where: { isActive: true },
        include: {
          aggregator: {
            select: {
              id: true,
              name: true,
              mail: true,
            },
          },
        },
      },
    };

    const updated = await prisma.customer.update({
      where: { id: parseInt(customerId) },
      data: updateData,
      include: includeConfig,
    });

    // Audit log
    const userName = (request.user as any)?.name || request.user!.email;
    
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: userName,
        emailAddress: request.user!.email,
        activity: `Updated customer ${existingCustomer.meterToken}`,
        meterId: existingCustomer.meterToken,
        state: updated.state,
        reason: 'Customer update',
      },
    });

    return NextResponse.json(
      { success: true, data: updated },
      { status: 200, headers: getCorsHeaders(request.headers.get('origin')) }
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

// Exports with auth
/**
 * @swagger
 * /api/customer/{id}:
 *   get:
 *     summary: Get a single customer by ID
 *     tags: [Customer]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Customer record.
 *       400:
 *         description: Invalid ID.
 *       404:
 *         description: Customer not found.
 */
export const GET = authenticate(getHandler);

/**
 * @swagger
 * /api/customer:
 *   post:
 *     summary: Create a new customer
 *     tags: [Customer]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [meterToken, riskLevel, outstanding, status, state]
 *             properties:
 *               meterToken:
 *                 type: string
 *               riskLevel:
 *                 type: string
 *               outstanding:
 *                 type: number
 *               status:
 *                 type: string
 *               state:
 *                 type: string
 *               dateAdded:
 *                 type: string
 *                 format: date-time
 *               aggregatorIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       201:
 *         description: Customer created successfully.
 *       400:
 *         description: Missing required fields, invalid aggregator IDs, or meter number already exists.
 */
export const POST = authorize(UserType.MONSERA_ADMIN, UserType.AGGREGATOR)(postHandler);


export const PUT = authorize(UserType.MONSERA_ADMIN, UserType.AGGREGATOR)(putHandler);