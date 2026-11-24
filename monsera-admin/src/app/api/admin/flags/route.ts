import { NextResponse } from '../../../../lib/next-server';
import { authenticate, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getAllFlags, setFlag, FlagKey } from '../../../../lib/feature-flags';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';
import { authorize } from '../../../../middleware/auth';

// CORS preflight — browsers send this before any request carrying Authorization.
export function OPTIONS(request: Request) {
  return handleOptions(request);
}

const KNOWN_FLAGS: FlagKey[] = [
  'disbursements_enabled',
  'scoring_engine_enabled',
  'recovery_enabled',
  'maintenance_mode',
  'credit_enabled',
];

// GET /api/admin/flags — list all flags
async function getHandler(request: AuthenticatedRequest) {
  try {
    const flags = await getAllFlags();
    return NextResponse.json({ success: true, data: flags }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, message: 'Failed to fetch flags' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

// POST /api/admin/flags — update a flag
async function postHandler(request: AuthenticatedRequest) {
  try {
    const { key, enabled } = await request.json();

    if (!key || !KNOWN_FLAGS.includes(key) || typeof enabled !== 'boolean') {
      return NextResponse.json(
        { success: false, message: `key must be one of ${KNOWN_FLAGS.join(', ')} and enabled must be a boolean` },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    await setFlag(key as FlagKey, enabled, request.user!.email);

    // Audit every flag change — these are operational controls on a live financial system
    const { default: prisma } = await import('../../../../lib/prisma');
    await prisma.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Feature flag '${key}' set to ${enabled} by ${request.user!.email}`,
      },
    });

    return NextResponse.json({
      success: true,
      message: `Flag '${key}' set to ${enabled}`,
    }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, message: 'Failed to update flag' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

export const GET = authorize(UserType.MONSERA_ADMIN)(getHandler);
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);