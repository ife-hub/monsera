import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

@Processor('recovery')
export class RecoveryProcessor extends WorkerHost {
  constructor(private prisma: PrismaService) {
    super();
  }

  async process(job: Job): Promise<any> {
    const { customerId, meterToken, amountPaidKobo, remainingOutstandingKobo } = job.data;
    await this.prisma.audit.create({
      data: { employeeName: 'System', emailAddress: 'system@monsera.com', activity: `Recovery event logged: Customer ${customerId} (meterToken: ${meterToken}) paid ${amountPaidKobo} kobo. Remaining outstanding: ${remainingOutstandingKobo} kobo.`, meterId: meterToken },
    });
    return { customerId, amountPaidKobo, remainingOutstandingKobo };
  }
}