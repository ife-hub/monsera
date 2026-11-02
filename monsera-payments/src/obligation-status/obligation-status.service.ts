import { Injectable } from '@nestjs/common';
import { TariffBand } from '@prisma/client';

export interface StatusWindows {
  expectedDays: number;
  watchDays: number;
  delayedDays: number;
  defaultDays: number;
  watchDate: Date;
  delayedDate: Date;
  defaultDate: Date;
  expectedRecoveryDate: Date;
}

@Injectable()
export class ObligationStatusService {
  computeStatusWindows(disbursedKobo: number, band: TariffBand, dailyBurnNaira: number, disbursementDate: Date): StatusWindows {
    const disbursedNaira = disbursedKobo / 100;
    const expectedDays = disbursedNaira / dailyBurnNaira;

    const watchDays = Math.max(2 * expectedDays, 5);
    const delayedDays = Math.max(4 * expectedDays, 10);
    const defaultDays = Math.min(Math.max(6 * expectedDays, 21), 45);

    const msPerDay = 24 * 60 * 60 * 1000;
    return {
      expectedDays, watchDays, delayedDays, defaultDays,
      expectedRecoveryDate: new Date(disbursementDate.getTime() + expectedDays * msPerDay),
      watchDate: new Date(disbursementDate.getTime() + watchDays * msPerDay),
      delayedDate: new Date(disbursementDate.getTime() + delayedDays * msPerDay),
      defaultDate: new Date(disbursementDate.getTime() + defaultDays * msPerDay),
    };
  }
}