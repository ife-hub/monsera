/*
  Warnings:

  - You are about to drop the column `meterNumber` on the `Customers` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[meterToken]` on the table `Customers` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `meterToken` to the `Customers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `walletType` to the `Wallet` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('Current', 'Watch', 'Delayed', 'Default', 'Discharged');

-- CreateEnum
CREATE TYPE "TariffBand" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('A', 'B');

-- DropIndex
DROP INDEX "Customers_meterNumber_key";

-- AlterTable — add meterToken with temporary default, copy from meterNumber, then remove default
ALTER TABLE "Customers" ADD COLUMN "band" "TariffBand" NOT NULL DEFAULT 'B';
ALTER TABLE "Customers" ADD COLUMN "meterToken" TEXT NOT NULL DEFAULT '';
UPDATE "Customers" SET "meterToken" = "meterNumber" WHERE "meterToken" = '';
ALTER TABLE "Customers" ALTER COLUMN "meterToken" DROP DEFAULT;
ALTER TABLE "Customers" DROP COLUMN "meterNumber";

-- AlterTable
ALTER TABLE "MonseraEarnings" ADD COLUMN     "transactionId" INTEGER;

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN "walletType" "WalletType" NOT NULL DEFAULT 'A';
UPDATE "Wallet" SET "walletType" = 'A' WHERE id = 1;
ALTER TABLE "Wallet" ALTER COLUMN "walletType" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Obligation" (
    "id" SERIAL NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "meterToken" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "discoAdminId" INTEGER NOT NULL,
    "obligationKobo" INTEGER NOT NULL,
    "disbursedKobo" INTEGER NOT NULL,
    "serviceKobo" INTEGER NOT NULL,
    "remainingKobo" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'Current',
    "band" "TariffBand" NOT NULL,
    "disbursementDate" TIMESTAMP(3) NOT NULL,
    "expectedRecoveryDate" TIMESTAMP(3) NOT NULL,
    "watchDate" TIMESTAMP(3) NOT NULL,
    "delayedDate" TIMESTAMP(3) NOT NULL,
    "defaultDate" TIMESTAMP(3) NOT NULL,
    "clockSuspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendedDays" INTEGER NOT NULL DEFAULT 0,
    "recoveredKobo" INTEGER NOT NULL DEFAULT 0,
    "principalRecoveredKobo" INTEGER NOT NULL DEFAULT 0,
    "serviceRecoveredKobo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Obligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObligationSuspension" (
    "id" SERIAL NOT NULL,
    "obligationId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObligationSuspension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObligationRecovery" (
    "id" SERIAL NOT NULL,
    "obligationId" INTEGER NOT NULL,
    "recoveryTransactionId" INTEGER NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "principalKobo" INTEGER NOT NULL,
    "serviceKobo" INTEGER NOT NULL,
    "walletBRecordId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObligationRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionLog" (
    "id" SERIAL NOT NULL,
    "decisionId" TEXT NOT NULL,
    "meterToken" TEXT NOT NULL,
    "band" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "parameterVersion" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "declineReason" TEXT,
    "approvedLimitKobo" INTEGER,
    "requestedKobo" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "timestampUtc" TIMESTAMP(3) NOT NULL,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" SERIAL NOT NULL,
    "walletId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "referenceId" TEXT,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditParameters" (
    "id" SERIAL NOT NULL,
    "version" TEXT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "minObligationKobo" INTEGER NOT NULL,
    "maxObligationKobo" INTEGER NOT NULL,
    "maxConcurrentObligations" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditParameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BurnRate" (
    "id" SERIAL NOT NULL,
    "band" "TariffBand" NOT NULL,
    "dailyBurnNaira" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BurnRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Obligation_meterToken_status_idx" ON "Obligation"("meterToken", "status");

-- CreateIndex
CREATE INDEX "Obligation_customerId_status_idx" ON "Obligation"("customerId", "status");

-- CreateIndex
CREATE INDEX "Obligation_status_defaultDate_idx" ON "Obligation"("status", "defaultDate");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionLog_decisionId_key" ON "DecisionLog"("decisionId");

-- CreateIndex
CREATE INDEX "DecisionLog_meterToken_idx" ON "DecisionLog"("meterToken");

-- CreateIndex
CREATE INDEX "DecisionLog_correlationId_idx" ON "DecisionLog"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditParameters_version_key" ON "CreditParameters"("version");

-- CreateIndex
CREATE UNIQUE INDEX "Customers_meterToken_key" ON "Customers"("meterToken");

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_discoAdminId_fkey" FOREIGN KEY ("discoAdminId") REFERENCES "DiscoAdmins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObligationSuspension" ADD CONSTRAINT "ObligationSuspension_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObligationRecovery" ADD CONSTRAINT "ObligationRecovery_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonseraEarnings" ADD CONSTRAINT "MonseraEarnings_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
