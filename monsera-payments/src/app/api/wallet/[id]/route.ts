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
        const data = await prisma.wallet.findUnique({where: { id }});
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