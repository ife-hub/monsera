-- Spec conformance: fixed obligation tiers, participating cohort, configurable
-- recovery-window thresholds, reconciliation run history.

ALTER TABLE "CreditParameters" ADD COLUMN "obligationTiersKobo" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

ALTER TABLE "Obligation" ADD COLUMN "windowParameterVersion" TEXT;

CREATE TABLE "RecoveryWindowParameters" (
    "id" SERIAL NOT NULL,
    "version" TEXT NOT NULL,
    "watchMultiplier" DECIMAL(6,3) NOT NULL,
    "delayedMultiplier" DECIMAL(6,3) NOT NULL,
    "defaultMultiplier" DECIMAL(6,3) NOT NULL,
    "minWatchDays" INTEGER NOT NULL,
    "minDelayedDays" INTEGER NOT NULL,
    "minDefaultDays" INTEGER NOT NULL,
    "maxDefaultDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecoveryWindowParameters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecoveryWindowParameters_version_key" ON "RecoveryWindowParameters"("version");

CREATE TABLE "CohortMeter" (
    "id" SERIAL NOT NULL,
    "meterToken" TEXT NOT NULL,
    "source" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    CONSTRAINT "CohortMeter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CohortMeter_meterToken_key" ON "CohortMeter"("meterToken");

CREATE TABLE "ReconciliationRun" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReconciliationRun_kind_period_idx" ON "ReconciliationRun"("kind", "period");
