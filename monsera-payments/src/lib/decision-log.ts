import { Prisma } from '@prisma/client';
import prisma from './prisma';

/**
 * Spec §6.1: every credit decision — approved or declined, whether reached by
 * the scoring engine or by a platform rule (cohort, blacklist, concurrency
 * limit, disabled disbursements, exhausted Wallet A) — is logged with the
 * complete feature vector that produced it. Each record is self-contained.
 */
export interface DecisionRecord {
  decisionId: string;
  meterToken: string;
  band: string;
  /** Every input value used, named. */
  features: Record<string, unknown>;
  /** Scoring model version, or `rule:<name>` when no model was applied. */
  modelVersion: string;
  parameterVersion: string;
  decision: 'approved' | 'declined';
  declineReason?: string | null;
  approvedLimitKobo?: number | null;
  requestedKobo: number;
  latencyMs: number;
  /** Transaction id the decision produced (approved decisions only). */
  correlationId?: string | null;
}

type Client = Prisma.TransactionClient | typeof prisma;

export async function recordDecision(record: DecisionRecord, client: Client = prisma) {
  return client.decisionLog.create({
    data: {
      decisionId: record.decisionId,
      meterToken: record.meterToken,
      band: record.band,
      features: record.features as Prisma.InputJsonValue,
      modelVersion: record.modelVersion,
      parameterVersion: record.parameterVersion,
      decision: record.decision,
      declineReason: record.decision === 'declined' ? (record.declineReason ?? 'Not eligible') : null,
      approvedLimitKobo: record.approvedLimitKobo ?? null,
      requestedKobo: record.requestedKobo,
      latencyMs: record.latencyMs,
      timestampUtc: new Date(),
      correlationId: record.correlationId ?? null,
    },
  });
}
