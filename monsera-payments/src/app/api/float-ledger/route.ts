// app/api/financeHouse/float-ledger/route.ts
import { NextResponse } from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authenticate, AuthenticatedRequest, authorize } from '../../../middleware/auth';
import { Prisma, UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';
import { adjustWallet, nairaToKobo, InsufficientWalletBalanceError, WALLET_A_ID, WALLET_C_ID } from '../../../lib/wallets';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * GET /api/float-ledger
 * Finance houses see their own entries, discos theirs, Monsera admins all.
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '10');
    const skip = (page - 1) * limit;

    const userType = request.user!.userType;
    let whereClause: Prisma.Float_LedgerWhereInput = {};

    if (userType === UserType.FINANCE_HOUSE) {
      // Finance house sees only their own ledger entries
      const financeHouse = await prisma.financeHouse.findUnique({
        where: { userId: request.user!.userId },
      });


      if (!financeHouse) {
        return NextResponse.json(
          { success: false, message: 'Finance house not found' },
          { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
        );
      }

      whereClause = { financeHouseId: financeHouse.id };

    } else if (userType === UserType.DISCO_ADMIN) {
      // Disco admin sees only ledger entries linked to their disco via discoAdminId
      const discoAdmin = await prisma.discoAdmin.findUnique({
        where: { userId: request.user!.userId },
      });

      if (!discoAdmin) {
        return NextResponse.json(
          { success: false, message: 'Disco admin not found' },
          { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
        );
      }

      whereClause = { discoAdminId: discoAdmin.id };

    } else if (userType === UserType.MONSERA_ADMIN) {
      // Monsera admin sees all entries — no filter
      whereClause = {};

    } else {
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 403, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    const [floatLedgers, total] = await Promise.all([
      prisma.float_Ledger.findMany({
        where: whereClause,
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
      prisma.float_Ledger.count({
        where: whereClause,
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

class FloatLedgerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * POST /api/float-ledger
 *
 * Two paths:
 *  - Allocation (Monsera admin, body has `discoId` or legacy `discoAdminId`):
 *    moves float from Wallet C to Wallet A and credits the disco's balance.
 *  - Credit (finance house): tops up Wallet C.
 *
 * Every balance change goes through adjustWallet inside one interactive
 * transaction: rows are locked, amounts are applied as increments (never a
 * read-modify-write of the absolute value, which used to erase concurrent
 * disbursements from Wallet A), and WalletTransaction rows are written so
 * reconciliation can account for the funding.
 */
async function postHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  try {
    const body = await request.json();
    const { amount, referenceId, attachmentUrl, type, discoId, discoAdminId } = body;

    if (!amount || !referenceId || !type || typeof referenceId !== 'string' || typeof type !== 'string') {
      return NextResponse.json(
        { success: false, message: 'Amount, type and reference ID are required' },
        { status: 400, headers }
      );
    }

    const amountKobo = nairaToKobo(amount);
    if (amountKobo === null) {
      return NextResponse.json(
        { success: false, message: 'Amount must be a positive number with at most 2 decimal places' },
        { status: 400, headers }
      );
    }
    const amountDecimal = new Prisma.Decimal(amountKobo).div(100);
    const ref = referenceId.trim();

    const existingEntry = await prisma.float_Ledger.findFirst({ where: { referenceId: ref } });
    if (existingEntry) {
      return NextResponse.json({ success: false, message: 'Reference ID already exists' }, { status: 400, headers });
    }

    const isAllocation = discoId !== undefined || discoAdminId !== undefined;

    if (isAllocation) {
      if (request.user!.userType !== UserType.MONSERA_ADMIN) {
        return NextResponse.json(
          { success: false, message: 'Only Monsera admins can allocate float to a disco' },
          { status: 403, headers }
        );
      }

      // `discoId` is the disco record id. `discoAdminId` is kept for the
      // existing frontend, which sends the disco admin's *user* id.
      const disco = discoId !== undefined
        ? await prisma.discoAdmin.findUnique({ where: { id: Number(discoId) } })
        : await prisma.discoAdmin.findUnique({ where: { userId: Number(discoAdminId) } });

      if (!disco) {
        return NextResponse.json({ success: false, message: 'Disco not found' }, { status: 404, headers });
      }

      const result = await prisma.$transaction(async (tx) => {
        // Lock Wallet C first: it is the float-ledger's running balance, so
        // every ledger writer serialises on it.
        const { newBalanceKobo: walletCKobo } = await adjustWallet(
          tx, WALLET_C_ID(), -amountKobo, 'allocation',
          `Float allocated to disco ${disco.name}`, ref
        );
        const { wallet: walletA } = await adjustWallet(
          tx, WALLET_A_ID(), amountKobo, 'allocation',
          `Float allocated to disco ${disco.name} from Wallet C`, ref
        );
        const lastEntry = await tx.float_Ledger.findFirst({ orderBy: [{ date: 'desc' }, { id: 'desc' }] });
        const currentFloatBalance = (lastEntry?.currentFloatBalance ?? new Prisma.Decimal(0)).sub(amountDecimal);

        const floatLedger = await tx.float_Ledger.create({
          data: {
            date: new Date(),
            referenceId: ref,
            amount: amountDecimal,
            type: type.trim(),
            currentFloatBalance,
            attachmentUrl: attachmentUrl || null,
            discoAdminId: disco.id,
          },
        });
        await tx.discoAdmin.update({
          where: { id: disco.id },
          data: { balance: { increment: amountDecimal }, updatedAt: new Date() },
        });
        await tx.audit.create({
          data: {
            userId: request.user!.userId,
            employeeName: request.user!.email,
            emailAddress: request.user!.email,
            activity: `Allocated float to disco ${disco.name}: ${ref} - ₦${amountDecimal.toString()} (Wallet C now ${walletCKobo} kobo)`,
          },
        });
        return { floatLedger, wallet: walletA };
      });

      return NextResponse.json({ success: true, data: result }, { status: 201, headers });
    }

    // ── Credit path (finance house topping up float) ─────────────────────────
    const financeHouse = await prisma.financeHouse.findUnique({
      where: { userId: request.user!.userId },
    });

    if (!financeHouse) {
      return NextResponse.json({ success: false, message: 'Finance house not found for this user' }, { status: 404, headers });
    }

    const result = await prisma.$transaction(async (tx) => {
      const { wallet } = await adjustWallet(
        tx, WALLET_C_ID(), amountKobo, 'top-up',
        `Float top-up from finance house ${financeHouse.name}`, ref
      );
      const lastEntry = await tx.float_Ledger.findFirst({ orderBy: [{ date: 'desc' }, { id: 'desc' }] });
      const currentFloatBalance = (lastEntry?.currentFloatBalance ?? new Prisma.Decimal(0)).add(amountDecimal);

      const floatLedger = await tx.float_Ledger.create({
        data: {
          date: new Date(),
          referenceId: ref,
          amount: amountDecimal,
          type: type.trim(),
          currentFloatBalance,
          attachmentUrl: attachmentUrl || null,
          financeHouseId: financeHouse.id,
        },
      });
      await tx.audit.create({
        data: {
          userId: request.user!.userId,
          employeeName: financeHouse.name,
          emailAddress: request.user!.email,
          activity: `Added float ledger credit entry: ${ref} - ₦${amountDecimal.toString()}`,
        },
      });
      return { floatLedger, wallet };
    });

    return NextResponse.json({ success: true, data: result }, { status: 201, headers });
  } catch (error: any) {
    console.error('Create float ledger error:', error);

    if (error instanceof InsufficientWalletBalanceError) {
      return NextResponse.json({ success: false, message: 'Insufficient wallet balance for this allocation' }, { status: 400, headers });
    }
    if (error instanceof FloatLedgerError) {
      return NextResponse.json({ success: false, message: error.message }, { status: error.status, headers });
    }
    if (error.code === 'P2002') {
      return NextResponse.json({ success: false, message: 'Reference ID already exists' }, { status: 400, headers });
    }
    if (error.code === 'P2003') {
      return NextResponse.json({ success: false, message: 'Invalid finance house or disco reference' }, { status: 400, headers });
    }
    if (typeof error.message === 'string' && error.message.startsWith('Wallet ') && error.message.endsWith('not found')) {
      return NextResponse.json({ success: false, message: 'Wallet not found' }, { status: 404, headers });
    }

    return NextResponse.json({ success: false, message: 'Failed to create float ledger entry' }, { status: 500, headers });
  }
}

export const GET = authenticate(getHandler);
export const POST = authorize(UserType.FINANCE_HOUSE, UserType.MONSERA_ADMIN)(postHandler);