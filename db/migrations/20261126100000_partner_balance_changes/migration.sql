-- Pending changes to disco and aggregator running totals (balance,
-- outstanding, lastInteraction). Advances and repayments append a row here
-- instead of updating the partner's row, which every advance through that
-- partner would otherwise queue on; a background job folds the rows into the
-- totals every couple of seconds (monsera-payments lib/partner-totals.ts).
CREATE TABLE "PartnerBalanceChange" (
    "id" SERIAL NOT NULL,
    "partnerType" TEXT NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "balanceDeltaKobo" INTEGER NOT NULL DEFAULT 0,
    "outstandingDeltaKobo" INTEGER NOT NULL DEFAULT 0,
    "interactionAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "PartnerBalanceChange_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PartnerBalanceChange_partnerType_check" CHECK ("partnerType" IN ('disco', 'aggregator'))
);

CREATE INDEX "PartnerBalanceChange_appliedAt_id_idx" ON "PartnerBalanceChange"("appliedAt", "id");
CREATE INDEX "PartnerBalanceChange_partnerType_partnerId_appliedAt_idx" ON "PartnerBalanceChange"("partnerType", "partnerId", "appliedAt");
