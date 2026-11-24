import { NextResponse } from '../../../../../lib/next-server';
import { getRouteId } from '../../../../../lib/route-params';
import prisma from '../../../../../lib/prisma';
import { authorize, AuthenticatedRequest } from '../../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../../lib/cors';
import { adjustWallet, nairaToKobo, InsufficientWalletBalanceError } from '../../../../../lib/wallets';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * PUT /api/wallet/add/:id   body: { balance: <naira amount> }
 *
 * Applies the change as a locked, atomic increment and records a
 * WalletTransaction ('top-up') so reconciliation can see it. The old version
 * read the balance, did float arithmetic in JS and wrote the absolute value
 * back, silently erasing any disbursement or recovery committed in between.
 */
async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  const id = await getRouteId(context);
  if (isNaN(id)) {
    return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers });
  }

  const { balance, referenceId } = await request.json();
  const amountKobo = nairaToKobo(balance);
  if (amountKobo === null) {
    return NextResponse.json(
      { success: false, message: 'balance must be a positive naira amount with at most 2 decimal places' },
      { status: 400, headers }
    );
  }

  try {
    const exists = await prisma.wallet.findUnique({ where: { id }, select: { id: true } });
    if (!exists) {
      return NextResponse.json({ success: false, message: 'Wallet ID not found' }, { status: 404, headers });
    }

    const { wallet } = await prisma.$transaction(async (tx) => {
      const result = await adjustWallet(
        tx,
        id,
        amountKobo,
        'top-up',
        `Top-up of ${amountKobo} kobo by ${request.user!.email}`,
        typeof referenceId === 'string' ? referenceId : undefined
      );
      await tx.audit.create({
        data: {
          userId: request.user!.userId,
          employeeName: request.user!.email,
          emailAddress: request.user!.email,
          activity: `Wallet ${id} top-up: ${amountKobo} kobo`,
        },
      });
      return result;
    });

    return NextResponse.json({ success: true, data: wallet }, { headers });
  } catch (error) {
    if (error instanceof InsufficientWalletBalanceError) {
      return NextResponse.json({ success: false, message: 'Insufficient balance' }, { status: 400, headers });
    }
    console.error('Update wallet balance error:', error);
    return NextResponse.json({ success: false, message: 'Failed to update wallet balance' }, { status: 500, headers });
  }
}

export const PUT = authorize(UserType.MONSERA_ADMIN, UserType.FINANCE_HOUSE)(putHandler);
