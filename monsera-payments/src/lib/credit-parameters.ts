import prisma from './prisma';
import { RATE_BPS, MIN_OBLIGATION_KOBO, MAX_OBLIGATION_KOBO } from './calculation';

export interface ActiveCreditParameters {
  version: string;
  rateBps: number;
  minObligationKobo: number;
  maxObligationKobo: number;
  maxConcurrentObligations: number;
  /** Fixed obligation tiers in kobo. Empty = any amount within min/max. */
  obligationTiersKobo: number[];
  source: 'database' | 'env';
}

/** Pilot tiers: ₦2,000 / ₦4,000 / ₦7,000. Override with OBLIGATION_TIERS_KOBO (comma-separated; empty disables). */
const DEFAULT_TIERS_KOBO = '200000,400000,700000';

export function envObligationTiersKobo(): number[] {
  const raw = process.env.OBLIGATION_TIERS_KOBO ?? DEFAULT_TIERS_KOBO;
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

/**
 * Returns the credit parameters currently in force.
 * Falls back to env values if no active CreditParameters row exists yet.
 */
export async function getActiveCreditParameters(): Promise<ActiveCreditParameters> {
  const row = await prisma.creditParameters.findFirst({
    where: { isActive: true, effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: 'desc' },
  });

  if (row) {
    return {
      version: row.version,
      rateBps: row.rateBps,
      minObligationKobo: row.minObligationKobo,
      maxObligationKobo: row.maxObligationKobo,
      maxConcurrentObligations: row.maxConcurrentObligations,
      obligationTiersKobo: row.obligationTiersKobo.length > 0 ? [...row.obligationTiersKobo].sort((a, b) => a - b) : envObligationTiersKobo(),
      source: 'database',
    };
  }

  return {
    version: process.env.CREDIT_PARAMETER_VERSION ?? 'v1.0',
    rateBps: RATE_BPS,
    minObligationKobo: MIN_OBLIGATION_KOBO,
    maxObligationKobo: MAX_OBLIGATION_KOBO,
    maxConcurrentObligations: 1,
    obligationTiersKobo: envObligationTiersKobo(),
    source: 'env',
  };
}