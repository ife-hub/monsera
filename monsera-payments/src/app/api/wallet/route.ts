import {NextRequest, NextResponse} from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { Prisma, UserType, WalletType } from '@prisma/client';
import { nairaToKobo } from '../../../lib/wallets';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

async function postHandler(request: AuthenticatedRequest){
    const headers = getCorsHeaders(request.headers.get('origin'));
    const body = await request.json();
    const { balance, walletType } = body;

    const openingKobo = Number(balance) === 0 ? 0 : nairaToKobo(balance);
    if (balance === undefined || openingKobo === null) {
        return NextResponse.json(
            { success: false, message: 'Invalid balance — must be zero or a positive naira amount (max 2 dp)' },
            { status: 400, headers }
        )
    }

    if (!walletType || !Object.values(WalletType).includes(walletType)) {
        return NextResponse.json(
            { success: false, message: `Invalid walletType — must be one of ${Object.values(WalletType).join(', ')}` },
            { status: 400, headers }
        )
    }

    try {
        // A non-zero opening balance is recorded as an 'opening-balance'
        // ledger row so reconciliation counts it as injected float.
        const wallet = await prisma.$transaction(async (tx) => {
            const created = await tx.wallet.create({
                data: { balance: new Prisma.Decimal(openingKobo).div(100), walletType },
            });
            if (openingKobo > 0) {
                await tx.walletTransaction.create({
                    data: {
                        walletId: created.id,
                        type: 'opening-balance',
                        amountKobo: openingKobo,
                        description: `Opening balance set by ${request.user!.email}`,
                    },
                });
            }
            return created;
        });
        return NextResponse.json({ success: true, data: wallet }, { status: 201, headers });
    } catch (error){
        console.error('Create wallet error:', error);
        return NextResponse.json({ success: false, message: 'Failed to create a wallet entry' }, { status: 500, headers })
    }
}

export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);