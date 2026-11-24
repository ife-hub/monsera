import { NextResponse } from '../../../lib/next-server';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { Prisma, UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';
import { getActiveWindowParameters } from '../../../lib/obligation-status';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/** GET — the §5.2 parameters in force (and ?history=true for all versions). */
async function getHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  if (new URL(request.url).searchParams.get('history') === 'true') {
    const history = await prisma.recoveryWindowParameters.findMany({ orderBy: { effectiveFrom: 'desc' } });
    return NextResponse.json({ success: true, data: history }, { headers });
  }
  return NextResponse.json({ success: true, data: await getActiveWindowParameters() }, { headers });
}

const FIELDS = ['watchMultiplier', 'delayedMultiplier', 'defaultMultiplier', 'minWatchDays', 'minDelayedDays', 'minDefaultDays', 'maxDefaultDays'] as const;

/**
 * POST — monthly recalibration (§5: thresholds are configuration). Applies
 * to advances disbursed from now on; existing obligations keep the windows
 * registered at disbursement. Omitted fields carry over.
 */
async function postHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  const body = (await request.json().catch(() => null)) ?? {};
  const current = await getActiveWindowParameters();
  const next: Record<(typeof FIELDS)[number], number> = { ...current };

  for (const field of FIELDS) {
    if (body[field] === undefined) continue;
    const v = body[field];
    const isMultiplier = field.endsWith('Multiplier');
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || (!isMultiplier && !Number.isInteger(v))) {
      return NextResponse.json({ success: false, message: `${field} must be a positive ${isMultiplier ? 'number' : 'integer'}` }, { status: 400, headers });
    }
    next[field] = v;
  }
  if (!(next.watchMultiplier <= next.delayedMultiplier && next.delayedMultiplier <= next.defaultMultiplier)) {
    return NextResponse.json({ success: false, message: 'Multipliers must satisfy watch <= delayed <= default' }, { status: 400, headers });
  }
  if (!(next.minWatchDays <= next.minDelayedDays && next.minDelayedDays <= next.minDefaultDays && next.minDefaultDays <= next.maxDefaultDays)) {
    return NextResponse.json({ success: false, message: 'Day bounds must satisfy minWatch <= minDelayed <= minDefault <= maxDefault' }, { status: 400, headers });
  }

  const now = new Date();
  const version = `rw-${now.toISOString().replace(/[:.]/g, '-')}`;
  const created = await prisma.$transaction(async (tx) => {
    await tx.recoveryWindowParameters.updateMany({ where: { isActive: true }, data: { isActive: false } });
    const row = await tx.recoveryWindowParameters.create({
      data: {
        version,
        watchMultiplier: new Prisma.Decimal(next.watchMultiplier),
        delayedMultiplier: new Prisma.Decimal(next.delayedMultiplier),
        defaultMultiplier: new Prisma.Decimal(next.defaultMultiplier),
        minWatchDays: next.minWatchDays,
        minDelayedDays: next.minDelayedDays,
        minDefaultDays: next.minDefaultDays,
        maxDefaultDays: next.maxDefaultDays,
        effectiveFrom: now,
      },
    });
    await tx.audit.create({
      data: {
        userId: request.user!.userId,
        employeeName: request.user!.email,
        emailAddress: request.user!.email,
        activity: `Recovery window parameters ${current.version} -> ${version}: ${JSON.stringify(next)}`,
      },
    });
    return row;
  });

  return NextResponse.json({ success: true, data: created }, { status: 201, headers });
}

export const GET = authenticate(getHandler);
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);
