import { NextResponse } from '../../../../lib/next-server';
import * as Sentry from '../../../../lib/monitoring';
import prisma from '../../../../lib/prisma';
import { authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';
import { SUSPENSION_REASONS } from '../../../../lib/recovery-window';
import { endSuspension, isSuspensionReason, startSuspension, type SuspensionScope } from '../../../../lib/suspensions';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

const MAX_CLOCK_SKEW_MS = 60_000;

/**
 * Resolves who the caller may act on. A disco admin is always confined to its
 * own disco's obligations; Monsera staff may name any meter or disco.
 */
async function resolveScope(request: AuthenticatedRequest, body: any): Promise<SuspensionScope | string> {
  const meterToken = typeof body.meterToken === 'string' && body.meterToken ? body.meterToken : undefined;
  const discoWide = body.discoWide === true;

  if (request.user!.userType === UserType.DISCO_ADMIN) {
    const disco = await prisma.discoAdmin.findUnique({ where: { userId: request.user!.userId }, select: { id: true } });
    if (!disco) return 'Disco admin not found';
    if (!meterToken && !discoWide) return 'Provide meterToken, or discoWide: true';
    return { meterToken: discoWide ? undefined : meterToken, discoAdminId: disco.id };
  }

  const discoAdminId = Number.isInteger(body.discoAdminId) ? body.discoAdminId : undefined;
  if (!meterToken && !discoAdminId) return 'Provide meterToken or discoAdminId';
  return { meterToken, discoAdminId };
}

/**
 * POST /api/obligations/suspensions — spec §5.3 clock suspension.
 *
 * body: {
 *   action: 'start' | 'end',
 *   reason: 'meter_unavailable' | 'ring_fence_changed' | 'customer_dispute' | 'disco_systems_unavailable',
 *   meterToken?: string,         // one meter's open obligations
 *   discoWide?: true,            // (disco admin) all of its open obligations
 *   discoAdminId?: number,       // (Monsera staff) all of a disco's open obligations
 *   at?: ISO-8601 timestamp      // when the condition started/ended; default now
 * }
 *
 * While a suspension is open the recovery clock does not accrue. Events are
 * recorded per obligation so elapsed days can be reconstructed.
 * disco_systems_unavailable suspends the clock only if the outage exceeds
 * 24 consecutive hours, so it must cover a disco, not a single meter.
 */
/**
 * @swagger
 * /api/obligations/suspensions:
 *   post:
 *     summary: Start or end a recovery-clock suspension (spec §5.3)
 *     description: >
 *       While a suspension is open the obligation's elapsed-days clock does not
 *       accrue. A disco admin may act on one of its meters (meterToken) or on
 *       all of its open obligations (discoWide). disco_systems_unavailable must
 *       be disco-wide and only suspends the clock if the outage exceeds 24
 *       consecutive hours. Repeating a start for the same reason is harmless.
 *     tags: [Obligations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action, reason]
 *             properties:
 *               action: { type: string, enum: [start, end] }
 *               reason:
 *                 type: string
 *                 enum: [meter_unavailable, ring_fence_changed, customer_dispute, disco_systems_unavailable]
 *               meterToken: { type: string }
 *               discoWide: { type: boolean }
 *               at: { type: string, format: date-time, description: When the condition started or ended (default now; not in the future). }
 *           example: { action: start, reason: customer_dispute, meterToken: Z6rdN8P8 }
 *     responses:
 *       200:
 *         description: Recorded. Returns the affected obligation ids.
 *         content:
 *           application/json:
 *             example: { success: true, data: { action: start, reason: customer_dispute, at: '2026-11-23T10:00:00.000Z', obligationIds: [412], affected: 1 } }
 *       400:
 *         description: Invalid action, reason, scope or timestamp.
 *       403:
 *         description: Caller is not a disco admin or Monsera staff.
 */
async function postHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  const fail = (message: string, status = 400) => NextResponse.json({ success: false, message }, { status, headers });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return fail('Request body must be valid JSON');
  }

  const { action, reason } = body ?? {};
  if (action !== 'start' && action !== 'end') return fail("action must be 'start' or 'end'");
  if (!isSuspensionReason(reason)) {
    return fail(`reason must be one of: ${Object.keys(SUSPENSION_REASONS).join(', ')}`);
  }

  const at = body.at === undefined ? new Date() : new Date(body.at);
  if (Number.isNaN(at.getTime())) return fail('at must be an ISO-8601 timestamp');
  if (at.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) return fail('at cannot be in the future');

  const scope = await resolveScope(request, body);
  if (typeof scope === 'string') return fail(scope, scope.endsWith('not found') ? 404 : 400);
  if (reason === 'disco_systems_unavailable' && scope.meterToken) {
    return fail('disco_systems_unavailable applies to a whole disco: use discoWide (or discoAdminId), not meterToken');
  }

  try {
    const obligationIds = await prisma.$transaction(async (tx) => {
      const ids = action === 'start'
        ? await startSuspension(tx, scope, reason, at)
        : await endSuspension(tx, scope, reason, at);
      await tx.audit.create({
        data: {
          userId: request.user!.userId,
          employeeName: request.user!.email,
          emailAddress: request.user!.email,
          activity: `Clock suspension ${action} (${reason}) at ${at.toISOString()} for ${
            scope.meterToken ? `meter ${scope.meterToken}` : `disco ${scope.discoAdminId}`
          }: obligations [${ids.join(', ')}]`,
          meterId: scope.meterToken ?? null,
          reason: SUSPENSION_REASONS[reason],
        },
      });
      return ids;
    });

    return NextResponse.json(
      { success: true, data: { action, reason, at: at.toISOString(), obligationIds, affected: obligationIds.length } },
      { status: 200, headers }
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { component: 'clock-suspension' } });
    console.error('Clock suspension error:', error);
    return fail('Failed to record clock suspension', 500);
  }
}

/** GET /api/obligations/suspensions?meterToken=… — suspension history for a meter's obligations. */
async function getHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  const meterToken = new URL(request.url).searchParams.get('meterToken');
  if (!meterToken) {
    return NextResponse.json({ success: false, message: 'meterToken is required' }, { status: 400, headers });
  }

  let discoFilter = {};
  if (request.user!.userType === UserType.DISCO_ADMIN) {
    const disco = await prisma.discoAdmin.findUnique({ where: { userId: request.user!.userId }, select: { id: true } });
    if (!disco) return NextResponse.json({ success: false, message: 'Disco admin not found' }, { status: 404, headers });
    discoFilter = { discoAdminId: disco.id };
  }

  const obligations = await prisma.obligation.findMany({
    where: { meterToken, ...discoFilter },
    orderBy: { disbursementDate: 'desc' },
    select: {
      id: true, status: true, disbursementDate: true, clockSuspended: true, suspendedDays: true,
      suspensions: { orderBy: { startedAt: 'asc' }, select: { id: true, reason: true, startedAt: true, endedAt: true } },
    },
  });
  return NextResponse.json({ success: true, data: obligations }, { headers });
}

export const POST = authorize(UserType.DISCO_ADMIN, UserType.MONSERA_ADMIN, UserType.EMPLOYEE)(postHandler);
export const GET = authorize(UserType.DISCO_ADMIN, UserType.MONSERA_ADMIN, UserType.EMPLOYEE)(getHandler);
