import { Prisma } from '@prisma/client';
import { WALLET_A_ID } from '../../../../lib/wallets';
import { walletABalanceKobo } from '../../../../lib/wallet-a';
import {NextRequest, NextResponse} from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

async function getHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }){
    const id = await getRouteId(context);
    if (isNaN(id)) {
        return NextResponse.json(
            {
                success: false,
                message: 'Invalid ID'
            },
            {
                status: 400,
                headers: getCorsHeaders(request.headers.get('origin'))
            }
        )
    }
    try {
        const row = await prisma.wallet.findUnique({ where: { id } });
        // Wallet A is Wallet A plus its sub-wallets (lib/wallet-a.ts): show the total.
        const data =
          row && id === WALLET_A_ID()
            ? await (async () => {
                const subWallets = await prisma.wallet.findMany({ where: { parentWalletId: id }, select: { id: true, balance: true }, orderBy: { id: 'asc' } });
                const totalKobo = await walletABalanceKobo();
                return { ...row, balance: new Prisma.Decimal(totalKobo).div(100), ownBalance: row.balance, subWallets };
              })()
            : row;
        if (!data) {
            return NextResponse.json(
                {
                    success: false, 
                    message: 'Wallet ID not found'
                },
                {
                    status: 404,
                    headers: getCorsHeaders(request.headers.get('origin'))
                }
            );
        }
        return NextResponse.json({success: true, data});
    } catch (error){
        console.error('Fetch wallet balance error:', error);
        return NextResponse.json(
            {
                success: false,
                message: 'Failed to fetch wallet balance'
            },
            {
                status: 500,
                headers: getCorsHeaders(request.headers.get('origin'))
            }
        )
    }
}

// Wallet A/B/C balances are Monsera's own float: staff and finance houses only.
export const GET = authorize(UserType.MONSERA_ADMIN, UserType.EMPLOYEE, UserType.FINANCE_HOUSE)(getHandler);