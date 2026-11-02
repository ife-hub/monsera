import { Injectable } from '@nestjs/common';

export interface DisbursementCalculation {
  obligationKobo: number;
  disbursedKobo: number;
  serviceKobo: number;
  rateBps: number;
}

@Injectable()
export class CalculationService {
  readonly RATE_BPS = Number(process.env.RATE_BPS ?? '1000');
  readonly MIN_OBLIGATION_KOBO = Number(process.env.MIN_OBLIGATION_KOBO ?? '200000');
  readonly MAX_OBLIGATION_KOBO = Number(process.env.MAX_OBLIGATION_KOBO ?? '700000');

  calculateDisbursement(obligationNaira: number, rateBps: number = this.RATE_BPS): DisbursementCalculation {
    const obligationKobo = Math.round(obligationNaira * 100);
    const disbursedKobo = Math.floor((obligationKobo * 10000) / (10000 + rateBps));
    const serviceKobo = obligationKobo - disbursedKobo;
    return { obligationKobo, disbursedKobo, serviceKobo, rateBps };
  }

  validateDisbursement(calc: DisbursementCalculation): void {
    const { obligationKobo, disbursedKobo, serviceKobo } = calc;

    if (disbursedKobo + serviceKobo !== obligationKobo) {
      throw new Error(`Calculation invariant violated: disbursed(${disbursedKobo}) + service(${serviceKobo}) != obligation(${obligationKobo})`);
    }
    if (disbursedKobo <= 0) {
      throw new Error(`Disbursed amount must be greater than zero, got ${disbursedKobo}`);
    }
    if (obligationKobo < this.MIN_OBLIGATION_KOBO) {
      throw new Error(`Obligation ${obligationKobo} kobo is below minimum ${this.MIN_OBLIGATION_KOBO} kobo`);
    }
    if (obligationKobo > this.MAX_OBLIGATION_KOBO) {
      throw new Error(`Obligation ${obligationKobo} kobo exceeds maximum ${this.MAX_OBLIGATION_KOBO} kobo`);
    }
  }
}