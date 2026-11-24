import { NextResponse } from '../../../../../lib/next-server';
import { getRouteId } from '../../../../../lib/route-params';
import prisma from '../../../../../lib/prisma';
import { authorize, AuthenticatedRequest } from '../../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../../lib/cors';
import { adjustWallet, lockWallet, nairaToKobo, InsufficientWalletBalanceError, COMMISSION_PAYOUT_TYPE, PRINCIPAL_RETURN_TYPE, WALLET_B_ID } from '../../../../../lib/wallets';
import { monthlySettlementBlocker } from '../../../../../lib/settlement-gate';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * PUT /api/wallet/subtract/:id
 *   body: { balance: <naira>, type?: 'withdrawal' | 'commission-payout', period?: 'YYYY-MM' }
 *   'withdrawal' = principal return (e.g. at pilot end); 'commission-payout'
 *   = monthly commission settlement from Wallet B, gated on reconciliation.
 *
 * Applies the change as a locked, atomic increment and records a
 * WalletTransaction ('withdrawal') so reconciliation can see it. The old version
 * read the balance, did float arithmetic in JS and wrote the absolute value
 * back, silently erasing any disbursement or recovery committed in between.
 */
async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  const id = await getRouteId(context);
  if (isNaN(id)) {
    return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers });
  }

  const { balance, referenceId, type = PRINCIPAL_RETURN_TYPE, period } = await request.json();
  const amountKobo = nairaToKobo(balance);
  if (type !== PRINCIPAL_RETURN_TYPE && type !== COMMISSION_PAYOUT_TYPE) {
    return NextResponse.json(
      { success: false, message: `type must be '${PRINCIPAL_RETURN_TYPE}' (principal return) or '${COMMISSION_PAYOUT_TYPE}' (monthly commission settlement)` },
      { status: 400, headers }
    );
  }
  const isCommission = type === COMMISSION_PAYOUT_TYPE;
  if (isCommission) {
    // §7: commission is settled monthly out of Wallet B, and only after that
    // month's reconciliation has passed (§8.3).
    if (id !== WALLET_B_ID()) {
      return NextResponse.json({ success: false, message: 'Commission is settled from Wallet B only' }, { status: 400, headers });
    }
    if (typeof period !== 'string' || !/^\d{4}-\d{2}$/.test(period)) {
      return NextResponse.json({ success: false, message: 'period (YYYY-MM, WAT) is required for a commission payout' }, { status: 400, headers });
    }
    const blocker = await monthlySettlementBlocker(period);
    if (blocker) return NextResponse.json({ success: false, message: blocker }, { status: 409, headers });
  }
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
      if (isCommission) {
        // Only commission that has actually been received may be paid out —
        // never the principal sitting in Wallet B awaiting the sweep.
        await lockWallet(tx, id);
        const [received, paid] = await Promise.all([
          tx.obligationRecovery.aggregate({ _sum: { serviceKobo: true } }),
          tx.walletTransaction.aggregate({ _sum: { amountKobo: true }, where: { walletId: id, type: COMMISSION_PAYOUT_TYPE } }),
        ]);
        const available = Number(received._sum.serviceKobo ?? 0) + Number(paid._sum.amountKobo ?? 0);
        if (amountKobo > available) throw new CommissionExceededError(available);
      }
      const result = await adjustWallet(
        tx,
        id,
        -amountKobo,
        type,
        isCommission
          ? `Commission settlement for ${period}: ${amountKobo} kobo by ${request.user!.email}`
          : `Principal return of ${amountKobo} kobo by ${request.user!.email}`,
        typeof referenceId === 'string' ? referenceId : isCommission ? `commission-${period}` : undefined
      );
      await tx.audit.create({
        data: {
          userId: request.user!.userId,
          employeeName: request.user!.email,
          emailAddress: request.user!.email,
          activity: `Wallet ${id} ${type}: ${amountKobo} kobo${isCommission ? ` for ${period}` : ''}`,
        },
      });
      return result;
    });

    return NextResponse.json({ success: true, data: wallet }, { headers });
  } catch (error) {
    if (error instanceof CommissionExceededError) {
      return NextResponse.json(
        { success: false, message: `Commission payout exceeds commission received and not yet paid out (${error.availableKobo} kobo)` },
        { status: 400, headers }
      );
    }
    if (error instanceof InsufficientWalletBalanceError) {
      return NextResponse.json({ success: false, message: 'Insufficient balance' }, { status: 400, headers });
    }
    console.error('Update wallet balance error:', error);
    return NextResponse.json({ success: false, message: 'Failed to update wallet balance' }, { status: 500, headers });
  }
}

class CommissionExceededError extends Error {
  constructor(public availableKobo: number) {
    super('Commission payout exceeds available commission');
  }
}

export const PUT = authorize(UserType.MONSERA_ADMIN)(putHandler);
