import { NextResponse } from './next-server';
import { PrismaClient, Prisma } from '@prisma/client';
import prisma from './prisma';

/** Spec §4.1: records expire on a configured TTL (IDEMPOTENCY_TTL_HOURS, default 24). */
export function idempotencyTtlHours(): number {
  const hours = Number(process.env.IDEMPOTENCY_TTL_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
}

function idempotencyExpiry(): Date {
  return new Date(Date.now() + idempotencyTtlHours() * 3_600_000);
}

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Checks whether an idempotency key has already been processed.
 * Returns the cached response if so, null if the request is new.
 * Called BEFORE the database transaction starts.
 */
export async function checkIdempotency(
  key: string,
  callerId: number,
  callerType: 'aggregator' | 'disco',
  corsHeaders: Record<string, string>
): Promise<NextResponse | null> {
  if (!key) {
    return NextResponse.json(
      { success: false, message: 'Idempotency-Key header is required' },
      { status: 400, headers: corsHeaders }
    );
  }

  const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });

  if (existing) {
    const ownedByAggregator = callerType === 'aggregator' && existing.aggregatorId === callerId;
    const ownedByDisco = callerType === 'disco' && existing.discoAdminId === callerId;

    if (!ownedByAggregator && !ownedByDisco) {
      return NextResponse.json(
        { success: false, message: 'Idempotency key belongs to a different caller' },
        { status: 403, headers: corsHeaders }
      );
    }

    // Return cached response — no state change
    return NextResponse.json(existing.responseBody as object, {
      status: existing.responseStatus,
      headers: { ...corsHeaders, 'X-Idempotent-Replay': 'true' },
    });
  }

  return null; // new request — proceed
}

/**
 * Writes the idempotency record INSIDE a Prisma transaction.
 *
 * This is the critical fix: by writing the record within the same transaction
 * as the balance change, the two operations are atomic. Either both commit or
 * neither does. Two concurrent requests carrying the same key can no longer
 * both complete and move money twice — the second one will hit a unique
 * constraint violation on the key and the entire transaction will roll back.
 *
 * Use this inside prisma.$transaction(async (tx) => { ... }) blocks.
 * Never call saveIdempotencyRecord (the standalone version) from inside
 * a transaction — it opens a separate connection and breaks atomicity.
 */
export async function saveIdempotencyRecordTx(
  tx: TransactionClient,
  key: string,
  callerId: number,
  callerType: 'aggregator' | 'disco',
  status: number,
  body: object
): Promise<void> {
  const expiresAt = idempotencyExpiry();

  await tx.idempotencyRecord.create({
    data: {
      key,
      aggregatorId: callerType === 'aggregator' ? callerId : null,
      discoAdminId: callerType === 'disco' ? callerId : null,
      responseStatus: status,
      responseBody: body,
      expiresAt,
    },
  });
}

/**
 * Standalone version for use outside of a transaction context.
 * Do NOT call this from inside prisma.$transaction — use saveIdempotencyRecordTx instead.
 */
export async function saveIdempotencyRecord(
  key: string,
  callerId: number,
  callerType: 'aggregator' | 'disco',
  status: number,
  body: object
): Promise<void> {
  const expiresAt = idempotencyExpiry();

  await prisma.idempotencyRecord.create({
    data: {
      key,
      aggregatorId: callerType === 'aggregator' ? callerId : null,
      discoAdminId: callerType === 'disco' ? callerId : null,
      responseStatus: status,
      responseBody: body,
      expiresAt,
    },
  });
}