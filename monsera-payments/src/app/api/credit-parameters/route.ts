import { NextResponse } from '../../../lib/next-server';
import { invalidateSettings } from '../../../lib/settings-cache';
import * as Sentry from '../../../lib/monitoring';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';
import { getActiveCreditParameters, envObligationTiersKobo } from '../../../lib/credit-parameters';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

const MAX_RATE_BPS = 5000; // 50% ceiling
const CREDIT_PARAMS_LOCK_KEY = 70010; // arbitrary constant for pg advisory lock

class ValidationError extends Error {}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * GET /api/credit-parameters
 * Any authenticated user. ?history=true returns every version, newest first.
 */
async function getHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  try {
    const { searchParams } = new URL(request.url);

    if (searchParams.get('history') === 'true') {
      const history = await prisma.creditParameters.findMany({
        orderBy: { effectiveFrom: 'desc' },
      });
      return NextResponse.json({ success: true, data: history }, { headers });
    }

    const active = await getActiveCreditParameters();
    return NextResponse.json({ success: true, data: active }, { headers });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Fetch credit parameters error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch credit parameters' },
      { status: 500, headers }
    );
  }
}

/**
 * POST /api/credit-parameters
 * MONSERA_ADMIN only. Creates a new versioned row and deactivates the previous one.
 * Body: { rateBps, minObligationKobo?, maxObligationKobo?, maxConcurrentObligations? }
 * Omitted optional fields are copied from the current active row (or env defaults).
 */
async function postHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  try {
    const body = await request.json();
    const { rateBps, minObligationKobo, maxObligationKobo, maxConcurrentObligations, obligationTiersKobo } = body ?? {};

    if (!Number.isInteger(rateBps) || rateBps < 1 || rateBps > MAX_RATE_BPS) {
      return NextResponse.json(
        { success: false, message: `rateBps must be an integer between 1 and ${MAX_RATE_BPS}` },
        { status: 400, headers }
      );
    }
    for (const [name, value] of [
      ['minObligationKobo', minObligationKobo],
      ['maxObligationKobo', maxObligationKobo],
      ['maxConcurrentObligations', maxConcurrentObligations],
    ] as const) {
      if (value !== undefined && !isPositiveInt(value)) {
        return NextResponse.json(
          { success: false, message: `${name} must be a positive integer` },
          { status: 400, headers }
        );
      }
    }

    if (
      obligationTiersKobo !== undefined &&
      (!Array.isArray(obligationTiersKobo) || !obligationTiersKobo.every(isPositiveInt))
    ) {
      return NextResponse.json(
        { success: false, message: 'obligationTiersKobo must be an array of positive integer kobo amounts' },
        { status: 400, headers }
      );
    }

    const result = await prisma.$transaction(
      async (tx) => {
        // Serialise concurrent POSTs (works even when no active row exists yet)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CREDIT_PARAMS_LOCK_KEY})`;

        const current = await tx.creditParameters.findFirst({
          where: { isActive: true },
          orderBy: { effectiveFrom: 'desc' },
        });

        // First ever row: fall back to env defaults for anything not supplied
        const base = current ?? {
          rateBps: null,
          minObligationKobo: Number(process.env.MIN_OBLIGATION_KOBO ?? '200000'),
          maxObligationKobo: Number(process.env.MAX_OBLIGATION_KOBO ?? '700000'),
          maxConcurrentObligations: 1,
          obligationTiersKobo: envObligationTiersKobo(),
        };

        const next = {
          rateBps: rateBps as number,
          minObligationKobo: (minObligationKobo as number | undefined) ?? base.minObligationKobo,
          maxObligationKobo: (maxObligationKobo as number | undefined) ?? base.maxObligationKobo,
          maxConcurrentObligations:
            (maxConcurrentObligations as number | undefined) ?? base.maxConcurrentObligations,
          // Fixed tiers carry over unless replaced; [] removes the tier rule.
          obligationTiersKobo: [...new Set(
            (obligationTiersKobo as number[] | undefined) ??
              (base.obligationTiersKobo.length > 0 ? base.obligationTiersKobo : envObligationTiersKobo())
          )].sort((a, b) => a - b),
        };

        if (next.minObligationKobo >= next.maxObligationKobo) {
          throw new ValidationError('minObligationKobo must be less than maxObligationKobo');
        }
        const outOfRange = next.obligationTiersKobo.filter(
          (t) => t < next.minObligationKobo || t > next.maxObligationKobo
        );
        if (outOfRange.length > 0) {
          throw new ValidationError(`Tiers outside min/max: ${outOfRange.join(', ')}`);
        }

        await tx.creditParameters.updateMany({
          where: { isActive: true },
          data: { isActive: false },
        });

        const now = new Date();
        const version = `v${now.toISOString().replace(/[:.]/g, '-')}`;

        const created = await tx.creditParameters.create({
          data: { version, ...next, isActive: true, effectiveFrom: now },
        });

        await tx.audit.create({
          data: {
            userId: request.user!.userId,
            employeeName: request.user!.email,
            emailAddress: request.user!.email,
            activity:
              `Credit parameters ${version}: rateBps ${current?.rateBps ?? 'none'} -> ${next.rateBps}, ` +
              `min ${current?.minObligationKobo ?? 'none'} -> ${next.minObligationKobo}, ` +
              `max ${current?.maxObligationKobo ?? 'none'} -> ${next.maxObligationKobo}, ` +
              `maxConcurrent ${current?.maxConcurrentObligations ?? 'none'} -> ${next.maxConcurrentObligations}, ` +
              `tiers [${current?.obligationTiersKobo?.join(',') ?? 'none'}] -> [${next.obligationTiersKobo.join(',')}]`,
          },
        });

        return created;
      },
      { timeout: 15000, maxWait: 5000 }
    );

    invalidateSettings('credit-parameters'); // this instance at once; others within SETTINGS_CACHE_MS
    return NextResponse.json({ success: true, data: result }, { status: 201, headers });
  } catch (error: any) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 400, headers });
    }
    Sentry.captureException(error);
    console.error('Create credit parameters error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to update credit parameters' },
      { status: 500, headers }
    );
  }
}

export const GET = authenticate(getHandler);
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);