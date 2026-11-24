-- CreateEnum
CREATE TYPE "VendRecordStatus" AS ENUM ('Pending', 'Processed', 'Failed');

-- CreateTable
CREATE TABLE "VendRecord" (
    "id" SERIAL NOT NULL,
    "discoAdminId" INTEGER NOT NULL,
    "partnerVendId" TEXT NOT NULL,
    "meterToken" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "vendType" TEXT,
    "vendedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB NOT NULL,
    "status" "VendRecordStatus" NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendRecordRevision" (
    "id" SERIAL NOT NULL,
    "vendRecordId" INTEGER NOT NULL,
    "previousPayload" JSONB NOT NULL,
    "newPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendRecordRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendIngestionFailure" (
    "id" SERIAL NOT NULL,
    "discoAdminId" INTEGER NOT NULL,
    "partnerVendId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendIngestionFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerVendMetrics" (
    "id" SERIAL NOT NULL,
    "meterToken" TEXT NOT NULL,
    "vendCountLast60Days" INTEGER NOT NULL DEFAULT 0,
    "daysSinceLastVend" INTEGER NOT NULL DEFAULT 0,
    "vendFrequency" INTEGER NOT NULL DEFAULT 0,
    "medianVendAmountKobo" INTEGER NOT NULL DEFAULT 0,
    "vendAmountVolatility" INTEGER NOT NULL DEFAULT 0,
    "interVendVarianceDays" INTEGER NOT NULL DEFAULT 0,
    "lastCalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerVendMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendRecord_meterToken_vendedAt_idx" ON "VendRecord"("meterToken", "vendedAt");

-- CreateIndex
CREATE INDEX "VendRecord_discoAdminId_status_idx" ON "VendRecord"("discoAdminId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VendRecord_discoAdminId_partnerVendId_key" ON "VendRecord"("discoAdminId", "partnerVendId");

-- CreateIndex
CREATE INDEX "VendRecordRevision_vendRecordId_idx" ON "VendRecordRevision"("vendRecordId");

-- CreateIndex
CREATE INDEX "VendIngestionFailure_discoAdminId_reportedAt_idx" ON "VendIngestionFailure"("discoAdminId", "reportedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerVendMetrics_meterToken_key" ON "CustomerVendMetrics"("meterToken");

-- AddForeignKey
ALTER TABLE "VendRecord" ADD CONSTRAINT "VendRecord_discoAdminId_fkey" FOREIGN KEY ("discoAdminId") REFERENCES "DiscoAdmins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendRecordRevision" ADD CONSTRAINT "VendRecordRevision_vendRecordId_fkey" FOREIGN KEY ("vendRecordId") REFERENCES "VendRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendIngestionFailure" ADD CONSTRAINT "VendIngestionFailure_discoAdminId_fkey" FOREIGN KEY ("discoAdminId") REFERENCES "DiscoAdmins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
