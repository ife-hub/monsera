import { NextResponse } from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';
import { addToCohort, removeFromCohort } from '../../../lib/cohort';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

const MAX_TOKENS_PER_REQUEST = 5000;

/** GET /api/cohort?meterToken=… — membership of one meter, or cohort counts. */
async function getHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  const meterToken = new URL(request.url).searchParams.get('meterToken');
  if (meterToken) {
    const row = await prisma.cohortMeter.findUnique({ where: { meterToken } });
    return NextResponse.json({ success: true, data: { meterToken, inCohort: !!row && row.removedAt === null, record: row } }, { headers });
  }
  const [active, removed] = await Promise.all([
    prisma.cohortMeter.count({ where: { removedAt: null } }),
    prisma.cohortMeter.count({ where: { removedAt: { not: null } } }),
  ]);
  return NextResponse.json({ success: true, data: { active, removed } }, { headers });
}

/**
 * POST /api/cohort — body { action: 'add' | 'remove', meterTokens: string[], source?: string }
 * Removing a meter (ring-fence released) suspends the clock on its open obligations.
 */
async function postHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  const body = await request.json().catch(() => null);
  const { action, meterTokens, source } = body ?? {};

  if (action !== 'add' && action !== 'remove') {
    return NextResponse.json({ success: false, message: "action must be 'add' or 'remove'" }, { status: 400, headers });
  }
  if (!Array.isArray(meterTokens) || meterTokens.length === 0 || meterTokens.length > MAX_TOKENS_PER_REQUEST ||
      !meterTokens.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 100)) {
    return NextResponse.json(
      { success: false, message: `meterTokens must be 1–${MAX_TOKENS_PER_REQUEST} non-empty strings` },
      { status: 400, headers }
    );
  }

  const result = action === 'add'
    ? { changed: await addToCohort(meterTokens, typeof source === 'string' ? source : 'api') }
    : await removeFromCohort(meterTokens);

  await prisma.audit.create({
    data: {
      userId: request.user!.userId,
      employeeName: request.user!.email,
      emailAddress: request.user!.email,
      activity: `Cohort ${action}: ${meterTokens.length} meter tokens submitted, result ${JSON.stringify(result)}`,
    },
  });

  return NextResponse.json({ success: true, data: result }, { headers });
}

export const GET = authorize(UserType.MONSERA_ADMIN, UserType.EMPLOYEE, UserType.DISCO_ADMIN)(getHandler);
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);
