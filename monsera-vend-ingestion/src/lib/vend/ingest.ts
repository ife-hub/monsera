import prisma from '../prisma';
import { vendMetricsQueue } from '../queues';
import { VendType, VendStatus, Prisma } from '@prisma/client';

const ALLOWED_FIELDS = ['partnerVendId', 'meterToken', 'amountKobo', 'vendType', 'vendStatus', 'vendedAt'] as const;
const PARTNER_VEND_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_STORED_FAILURE_TEXT = 200;
const DB_CONCURRENCY = 5; // matches connection_limit=5 in lib/prisma.ts

export interface IncomingVend {
  partnerVendId: string;
  meterToken: string;
  amountKobo: number;
  vendType: string;
  vendStatus: string;
  vendedAt: string;
}

export interface VendResult {
  partnerVendId: string;
  status: 'accepted' | 'rejected';
  reason?: string;
}

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, MAX_STORED_FAILURE_TEXT);
}

function validateVend(vend: any): { error: string | null; unrecognizedFields: string[] } {
  if (vend === null || typeof vend !== 'object' || Array.isArray(vend)) {
    return { error: 'Each vend must be a JSON object', unrecognizedFields: [] };
  }
  const unrecognizedFields = Object.keys(vend).filter((k) => !ALLOWED_FIELDS.includes(k as any));
  if (unrecognizedFields.length > 0) {
    return { error: `Unrecognized field(s): ${unrecognizedFields.join(', ')}`, unrecognizedFields };
  }
  if (!vend.partnerVendId || typeof vend.partnerVendId !== 'string' || !PARTNER_VEND_ID_PATTERN.test(vend.partnerVendId)) {
    return { error: 'partnerVendId is required and must match ^[A-Za-z0-9_-]{1,100}$', unrecognizedFields };
  }
  if (!vend.meterToken || typeof vend.meterToken !== 'string' || vend.meterToken.length > 100) {
    return { error: 'meterToken is required and must be a string of 1-100 characters', unrecognizedFields };
  }
  if (typeof vend.amountKobo !== 'number' || !Number.isInteger(vend.amountKobo) || vend.amountKobo <= 0) {
    return { error: 'amountKobo is required and must be a positive integer', unrecognizedFields };
  }
  if (!vend.vendType || !Object.values(VendType).includes(vend.vendType)) {
    return { error: `vendType is required and must be one of: ${Object.values(VendType).join(', ')}`, unrecognizedFields };
  }
  if (!vend.vendStatus || !Object.values(VendStatus).includes(vend.vendStatus)) {
    return { error: `vendStatus is required and must be one of: ${Object.values(VendStatus).join(', ')}`, unrecognizedFields };
  }
  if (!vend.vendedAt || typeof vend.vendedAt !== 'string' || isNaN(Date.parse(vend.vendedAt))) {
    return { error: 'vendedAt is required and must be a valid ISO 8601 timestamp', unrecognizedFields };
  }
  return { error: null, unrecognizedFields };
}

function failureRow(discoAdminId: number, vend: any, reason: string, unrecognizedFields: string[]) {
  const source = vend !== null && typeof vend === 'object' ? vend : {};
  return {
    discoAdminId,
    submittedPartnerVendId: asText(source.partnerVendId),
    submittedMeterToken: asText(source.meterToken),
    submittedAmountKobo: asText(source.amountKobo),
    submittedVendType: asText(source.vendType),
    submittedVendStatus: asText(source.vendStatus),
    submittedVendedAt: asText(source.vendedAt),
    unrecognizedFields: unrecognizedFields.length > 0 ? asText(unrecognizedFields.join(', ')) : null,
    reason,
  };
}

async function runInChunks<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export async function ingestVends(
  discoAdminId: number,
  vends: IncomingVend[]
): Promise<{ results: VendResult[]; touchedMeterTokens: Set<string> }> {
  const results: VendResult[] = new Array(vends.length);
  const failureRows: any[] = [];
  const touchedMeterTokens = new Set<string>();

  // ── Pass 1: schema validation + in-batch duplicate check (no DB calls) ──
  const seenInBatch = new Set<string>();
  const validItems: Array<{ index: number; vend: IncomingVend }> = [];

  vends.forEach((vend, index) => {
    const { error, unrecognizedFields } = validateVend(vend);
    if (error) {
      results[index] = { partnerVendId: asText((vend as any)?.partnerVendId) ?? '(missing)', status: 'rejected', reason: error };
      failureRows.push(failureRow(discoAdminId, vend, error, unrecognizedFields));
      return;
    }
    const v = vend as IncomingVend;
    if (seenInBatch.has(v.partnerVendId)) {
      const reason = 'duplicate partnerVendId within this batch';
      results[index] = { partnerVendId: v.partnerVendId, status: 'rejected', reason };
      failureRows.push(failureRow(discoAdminId, v, reason, []));
      return;
    }
    seenInBatch.add(v.partnerVendId);
    validItems.push({ index, vend: v });
  });

  if (validItems.length === 0) {
    if (failureRows.length > 0) await prisma.vendIngestionFailure.createMany({ data: failureRows });
    return { results, touchedMeterTokens };
  }

  // ── Pass 2: single query for everything that already exists ────────────
  const existingRecords = await prisma.vendRecord.findMany({
    where: { discoAdminId, partnerVendId: { in: validItems.map((i) => i.vend.partnerVendId) } },
  });
  const existingByPartnerVendId = new Map(existingRecords.map((r) => [r.partnerVendId, r]));

  // ── Pass 3: split into create / update / reject-on-meter-mismatch ──────
  const toCreate: Array<{ index: number; vend: IncomingVend }> = [];
  const toUpdate: Array<{ index: number; vend: IncomingVend; existing: (typeof existingRecords)[number] }> = [];

  for (const { index, vend } of validItems) {
    const existing = existingByPartnerVendId.get(vend.partnerVendId);
    if (existing && existing.meterToken !== vend.meterToken) {
      const reason = 'partnerVendId already exists for a different meterToken';
      results[index] = { partnerVendId: vend.partnerVendId, status: 'rejected', reason };
      failureRows.push(failureRow(discoAdminId, vend, reason, []));
      continue;
    }
    if (existing) {
      toUpdate.push({ index, vend, existing });
    } else {
      toCreate.push({ index, vend });
    }
    touchedMeterTokens.add(vend.meterToken);
  }

  // ── Write: new records, one batched call ────────────────────────────────
  if (toCreate.length > 0) {
    try {
      await prisma.vendRecord.createMany({
        data: toCreate.map(({ vend }) => ({
          discoAdminId,
          partnerVendId: vend.partnerVendId,
          meterToken: vend.meterToken,
          amountKobo: vend.amountKobo,
          vendType: vend.vendType as VendType,
          vendStatus: vend.vendStatus as VendStatus,
          vendedAt: new Date(vend.vendedAt),
          processingStatus: 'Pending',
        })),
      });
      toCreate.forEach(({ index, vend }) => {
        results[index] = { partnerVendId: vend.partnerVendId, status: 'accepted' };
      });
    } catch (error: any) {
      // Batched insert failed as a whole (rare — e.g. a race against a
      // record created by a different request between Pass 2 and here).
      // Fall back to per-item so one bad row doesn't sink the batch.
      await runInChunks(toCreate, DB_CONCURRENCY, async ({ index, vend }) => {
        try {
          await prisma.vendRecord.create({
            data: {
              discoAdminId,
              partnerVendId: vend.partnerVendId,
              meterToken: vend.meterToken,
              amountKobo: vend.amountKobo,
              vendType: vend.vendType as VendType,
              vendStatus: vend.vendStatus as VendStatus,
              vendedAt: new Date(vend.vendedAt),
              processingStatus: 'Pending',
            },
          });
          results[index] = { partnerVendId: vend.partnerVendId, status: 'accepted' };
        } catch (itemError: any) {
          // Unique violation: a concurrent request (e.g. the partner retrying
          // the same batch before the first reply) created this vend after
          // Pass 2. Treat it as the resend it is rather than rejecting it.
          if (itemError?.code === 'P2002') {
            const existing = await prisma.vendRecord.findUnique({
              where: { discoAdminId_partnerVendId: { discoAdminId, partnerVendId: vend.partnerVendId } },
            });
            if (existing && existing.meterToken === vend.meterToken) {
              toUpdate.push({ index, vend, existing });
              return;
            }
            if (existing) {
              const reason = 'partnerVendId already exists for a different meterToken';
              results[index] = { partnerVendId: vend.partnerVendId, status: 'rejected', reason };
              failureRows.push(failureRow(discoAdminId, vend, reason, []));
              return;
            }
          }
          results[index] = { partnerVendId: vend.partnerVendId, status: 'rejected', reason: 'Internal error processing this vend' };
          failureRows.push(failureRow(discoAdminId, vend, itemError.message, []));
        }
      });
    }
  }

  // ── Write: resends — inherently per-row, run concurrently in chunks ────
  const revisionRows: any[] = [];
  await runInChunks(toUpdate, DB_CONCURRENCY, async ({ index, vend, existing }) => {
    const vendType = vend.vendType as VendType;
    const vendStatus = vend.vendStatus as VendStatus;
    const vendedAt = new Date(vend.vendedAt);
    const changed =
      existing.amountKobo !== vend.amountKobo ||
      existing.vendType !== vendType ||
      existing.vendStatus !== vendStatus ||
      existing.vendedAt.getTime() !== vendedAt.getTime();

    try {
      await prisma.vendRecord.update({
        where: { id: existing.id },
        data: { amountKobo: vend.amountKobo, vendType, vendStatus, vendedAt, processingStatus: 'Pending' },
      });
      if (changed) {
        revisionRows.push({
          vendRecordId: existing.id,
          previousAmountKobo: existing.amountKobo,
          newAmountKobo: vend.amountKobo,
          previousVendType: existing.vendType,
          newVendType: vendType,
          previousVendStatus: existing.vendStatus,
          newVendStatus: vendStatus,
          previousVendedAt: existing.vendedAt,
          newVendedAt: vendedAt,
        });
      }
      results[index] = { partnerVendId: vend.partnerVendId, status: 'accepted' };
    } catch (error: any) {
      results[index] = { partnerVendId: vend.partnerVendId, status: 'rejected', reason: 'Internal error processing this vend' };
      failureRows.push(failureRow(discoAdminId, vend, error.message, []));
    }
  });

  if (revisionRows.length > 0) await prisma.vendRecordRevision.createMany({ data: revisionRows });
  if (failureRows.length > 0) await prisma.vendIngestionFailure.createMany({ data: failureRows });

  // ── Enqueue metrics recalculation — Redis, not Postgres, no pool limit ──
  // One job per meter per request, with no fixed jobId. A fixed id
  // (vend-metrics-<meter>) made BullMQ ignore the add while that meter's job
  // was still running, so vends arriving mid-calculation stayed Pending with
  // stale features until some later vend for the meter. The job recomputes
  // from the database, so an extra run is harmless.
  await Promise.all(
    [...touchedMeterTokens].map((meterToken) =>
      vendMetricsQueue.add('recalculate-vend-metrics', { meterToken })
    )
  );

  return { results, touchedMeterTokens };
}