import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

type TransactionClient = Omit<Prisma.TransactionClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
type CallerType = 'aggregator' | 'disco';

@Injectable()
export class IdempotencyService {
  constructor(private prisma: PrismaService) {}

  /**
   * Call BEFORE the transaction. Throws HttpException (caught by the
   * global filter) if the key is missing, belongs to a different caller,
   * or this is a replay — in the replay case the thrown body IS the
   * cached response, so the controller never has to special-case it.
   */
  async checkIdempotency(key: string | undefined, callerId: number, callerType: CallerType): Promise<void> {
    if (!key) {
      throw new BadRequestException({ success: false, message: 'Idempotency-Key header is required' });
    }

    const existing = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!existing) return;

    const ownedByAggregator = callerType === 'aggregator' && existing.aggregatorId === callerId;
    const ownedByDisco = callerType === 'disco' && existing.discoAdminId === callerId;
    if (!ownedByAggregator && !ownedByDisco) {
      throw new ForbiddenException({ success: false, message: 'Idempotency key belongs to a different caller' });
    }

    // Replay: throw the cached status/body directly as the response.
    const { HttpException } = await import('@nestjs/common');
    throw new HttpException(existing.responseBody as object, existing.responseStatus);
  }

  async saveRecordTx(tx: TransactionClient, key: string, callerId: number, callerType: CallerType, status: number, body: object): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

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
}