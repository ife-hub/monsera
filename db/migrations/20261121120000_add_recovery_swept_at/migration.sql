-- Track which recoveries have had their principal swept from Wallet B to
-- Wallet A, so the daily sweep is idempotent and independent of run time.
ALTER TABLE "ObligationRecovery" ADD COLUMN "sweptAt" TIMESTAMP(3);

-- Existing recoveries were handled by the previous date-window sweep. Mark
-- them swept so this migration can never cause a double sweep. Any recovery
-- the old job missed stays in Wallet B (the safe direction) and can be swept
-- manually after review.
UPDATE "ObligationRecovery" SET "sweptAt" = CURRENT_TIMESTAMP WHERE "sweptAt" IS NULL;

CREATE INDEX "ObligationRecovery_sweptAt_idx" ON "ObligationRecovery"("sweptAt");
