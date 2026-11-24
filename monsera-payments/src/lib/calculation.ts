/**
 * Spec Section 2 — Core Calculation
 *
 * All monetary values are held and computed as integer kobo.
 * No floating point type appears anywhere in the money path.
 * Rounding is always floor on disbursed, service takes the remainder.
 * This guarantees disbursed + service = obligation exactly in every case.
 */

export const RATE_BPS = Number(process.env.RATE_BPS ?? '1000');
export const MIN_OBLIGATION_KOBO = Number(process.env.MIN_OBLIGATION_KOBO ?? '200000');
export const MAX_OBLIGATION_KOBO = Number(process.env.MAX_OBLIGATION_KOBO ?? '700000');

export interface DisbursementCalculation {
  obligationKobo: number;
  disbursedKobo: number;
  serviceKobo: number;
  rateBps: number;
}

/**
 * Calculate disbursement from the obligation amount.
 *
 * Formula (spec Section 2):
 *   disbursed_kobo = floor(obligation_kobo * 10000 / (10000 + rate_bps))
 *   service_kobo   = obligation_kobo - disbursed_kobo
 */
export function calculateDisbursement(
  obligationNaira: number,
  rateBps: number = RATE_BPS
): DisbursementCalculation {
  // obligation_kobo = selected_amount_naira * 100. The request arrives as a
  // JSON number, so this is the one place a float is touched; amounts with
  // more than 2 decimal places are rejected rather than silently rounded.
  const obligationKobo = Math.round(obligationNaira * 100);
  if (Math.abs(obligationKobo - obligationNaira * 100) > 1e-6) {
    throw new Error('Amount must have at most 2 decimal places');
  }
  const disbursedKobo = Math.floor((obligationKobo * 10000) / (10000 + rateBps));
  const serviceKobo = obligationKobo - disbursedKobo;

  return { obligationKobo, disbursedKobo, serviceKobo, rateBps };
}

export interface ObligationLimits {
  minObligationKobo: number;
  maxObligationKobo: number;
  /** Permitted obligation amounts (fixed tiers). Empty/absent = any amount within min/max. */
  obligationTiersKobo?: number[];
}

/** Formats kobo as naira for error messages (presentation only). */
const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString('en-NG')}`;

export function validateDisbursement(
  calc: DisbursementCalculation,
  limits: ObligationLimits = {
    minObligationKobo: MIN_OBLIGATION_KOBO,
    maxObligationKobo: MAX_OBLIGATION_KOBO,
  }
): void {
  const { obligationKobo, disbursedKobo, serviceKobo } = calc;
  const { minObligationKobo, maxObligationKobo } = limits;

  if (disbursedKobo + serviceKobo !== obligationKobo) {
    throw new Error(
      `Calculation invariant violated: disbursed(${disbursedKobo}) + service(${serviceKobo}) != obligation(${obligationKobo})`
    );
  }
  if (disbursedKobo <= 0) {
    throw new Error(`Disbursed amount must be greater than zero, got ${disbursedKobo}`);
  }
  if (obligationKobo < minObligationKobo) {
    throw new Error(`Obligation ${obligationKobo} kobo is below minimum ${minObligationKobo} kobo`);
  }
  if (obligationKobo > maxObligationKobo) {
    throw new Error(`Obligation ${obligationKobo} kobo exceeds maximum ${maxObligationKobo} kobo`);
  }
  const tiers = limits.obligationTiersKobo ?? [];
  if (tiers.length > 0 && !tiers.includes(obligationKobo)) {
    throw new Error(`Obligation must be one of the configured tiers: ${tiers.map(naira).join(', ')}`);
  }
}

/** Convert kobo to naira for presentation layer only. */
export function koboToNaira(kobo: number): number {
  return kobo / 100;
}