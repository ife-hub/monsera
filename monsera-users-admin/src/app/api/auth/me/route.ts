import { authenticate, AuthenticatedRequest } from '../../../../middleware/auth';
import { safeAggregatorSelect, safeDiscoSelect } from '../../../../lib/safe-select';
import prisma from '../../../../lib/prisma';
import { NextResponse } from '../../../../lib/next-server';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

async function handler(request: AuthenticatedRequest) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      include: {
        employee: {
          include: { role: true }
        },
        aggregator: { select: safeAggregatorSelect },
        discoAdmin: { select: safeDiscoSelect },
        //customer: true,
        systemAdmin: true
      }
    });

    if (!user) {
      return NextResponse.json(
        { success: false, message: 'User not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    const { passwordHash, ...userWithoutPassword } = user;

    return NextResponse.json({
      success: true,
      data: userWithoutPassword
    });
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch user' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

export const GET = authenticate(handler);