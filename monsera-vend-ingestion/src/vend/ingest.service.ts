import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VendType, VendStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IncomingVendDto } from './dto/incoming-vend.dto';

const DB_CONCURRENCY = 5;

export interface VendResult {
  partnerVendId: string;
  status: 'accepted' | 'rejected';
  reason?: string;
}

@Injectable()
export class IngestService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('vend-metrics') private vendMetricsQueue: Queue,
  ) {}

  private async runInChunks<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
    for (let i = 0; i < items.length; i += size) {
      await Promise.all(items.slice(i, i + size).map(fn));
    }
  }

  private failureRow(discoAdminId: number, vend: IncomingVendDto, reason: string) {
    return {
      discoAdminId,
      submittedPartnerVendId: vend.partnerVendId ?? null,
      submittedMeterToken: vend.meterToken ?? null,
      submittedAmountKobo: vend.amountKobo !== undefined ? String(vend.amountKobo) : null,
      submittedVendType: vend.vendType ?? null,
      submittedVendStatus: vend.vendStatus ?? null,
      submittedVendedAt: vend.vendedAt ?? null,
      reason,
    };
  }

  async ingestVends(discoAdminId: number, vends: IncomingVendDto[]): Promise<{ results: VendResult[] }> {
    const results: VendResult[] = new Array(vends.length);
    const failureRows: any[] = [];
    const touchedMeterTokens = new Set<string>();

    const seenInBatch = new Set<string>();
    const validItems: Array<{ index: number; vend: IncomingVendDto }> = [];

    vends.forEach((vend, index) => {
      if (seenInBatch.has(vend.partnerVendId)) {
        const reason = 'duplicate partnerVendId within this batch';
        results[index] = { partnerVendId: vend.partnerVendId, status: 'rejected', reason };
        failureRows.push(this.failureRow(discoAdminId, vend, reason));
        return;
      }
      seenInBatch.add(vend.partnerVendId);
      validItems.push({ index, vend });
    });

    if (validItems.length === 0) {
      if (failureRows.length > 0) await this.prisma.vendIngestionFailure.createMany({ data: failureRows });
      return { results };
    }

    const existingRecords = await this.prisma.vendRecord.findMany({
      where: { discoAdminId, partnerVendId: { in: validItems.map((i) => i.vend.partnerVendId) } },
    });
    const existingByPartnerVendId = new Map(existingRecords.map((r) => [r.partnerVendId, r]));

    const toCreate: Array<{ index: number; vend: IncomingVendDto }> = [];
    const toUpdate: Array<{ index: number; vend: IncomingVendDto; existing: (typeof existingRecords)[number] }> = [];

    for (const { index, vend } of validItems) {
      const existing = existingByPartnerVendId.get(vend.partnerVendId);
      if (existing && existing.meterToken !== vend.meterToken) {
        const reason = 'partnerVendId already exists for a different meterToken';
        results[index] = { partnerVendId: vend.partnerVendId, status: 'rejected', reason };
        failureRows.push(this.failureRow(discoAdminId, vend, reason));
        continue;
      }
      if (existing) toUpdate.push({ index, vend, existing });
      else toCreate.push({ index, vend });
      touchedMeterTokens.add(vend.meterToken);
    }

    if (toCreate.length > 0) {
      try {
        await this.prisma.vendRecord.createMany({
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
      } catch {
        await this.runInChunks(toCreate, DB_CONCURRENCY, async ({ index, vend }) => {
          try {
            await this.prisma.vendRecord.create({
              data: {
                discoAdminId, partnerVendId: vend.partnerVendId, meterToken: vend.meterToken, amountKobo: vend.amountKobo,
                vendType: vend.vendType as VendType, vendStatus: vend.vendStatus as VendStatus, vendedAt: new Date(vend.vendedAt), processingStatus: 'Pending',
              },
            });
            results[index] = { partnerVendId: vend.partnerVendId, status: 'accepted' };
          } catch (itemError: any) {
            results[index] = { partnerVendId: vend.partnerVendId, status: 'rejected', reason: 'Internal error processing this vend' };
            failureRows.push(this.failureRow(discoAdminId, vend, itemError.message));
          }
        });
      }
    }

    const revisionRows: any[] = [];
    await this.runInChunks(toUpdate, DB_CONCURRENCY, async ({ index, vend, existing }) => {
      const vendType = vend.vendType as VendType;
      const vendStatus = vend.vendStatus as VendStatus;
      const vendedAt = new Date(vend.vendedAt);
      const changed = existing.amountKobo !== vend.amountKobo || existing.vendType !== vendType || existing.vendStatus !== vendStatus || existing.vendedAt.getTime() !== vendedAt.getTime();

      try {
        await this.prisma.vendRecord.update({ where: { id: existing.id }, data: { amountKobo: vend.amountKobo, vendType, vendStatus, vendedAt, processingStatus: 'Pending' } });
        if (changed) {
          revisionRows.push({
            vendRecordId: existing.id, previousAmountKobo: existing.amountKobo, newAmountKobo: vend.amountKobo,
            previousVendType: existing.vendType, newVendType: vendType, previousVendStatus: existing.vendStatus, newVendStatus: vendStatus,
            previousVendedAt: existing.vendedAt, newVendedAt: vendedAt,
          });
        }
        results[index] = { partnerVendId: vend.partnerVendId, status: 'accepted' };
      } catch (error: any) {
        results[index] = { partnerVendId: vend.partnerVendId, status: 'rejected', reason: 'Internal error processing this vend' };
        failureRows.push(this.failureRow(discoAdminId, vend, error.message));
      }
    });

    if (revisionRows.length > 0) await this.prisma.vendRecordRevision.createMany({ data: revisionRows });
    if (failureRows.length > 0) await this.prisma.vendIngestionFailure.createMany({ data: failureRows });

    await Promise.all(
      [...touchedMeterTokens].map((meterToken) =>
        this.vendMetricsQueue.add('recalculate-vend-metrics', { meterToken }, { jobId: `vend-metrics-${meterToken}` }),
      ),
    );

    return { results };
  }
}