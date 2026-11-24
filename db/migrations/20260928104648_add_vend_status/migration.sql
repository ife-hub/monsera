/*
  Warnings:

  - You are about to drop the column `status` on the `VendRecord` table. All the data in the column will be lost.
  - Added the required column `vendStatus` to the `VendRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `newVendStatus` to the `VendRecordRevision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `previousVendStatus` to the `VendRecordRevision` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "VendStatus" AS ENUM ('SUCCESSFUL', 'FAILED');

-- CreateEnum
CREATE TYPE "VendProcessingStatus" AS ENUM ('Pending', 'Processed');

-- DropIndex
DROP INDEX "VendRecord_discoAdminId_status_idx";

-- AlterTable
ALTER TABLE "CustomerVendMetrics" ADD COLUMN     "failedVendRatio" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "VendIngestionFailure" ADD COLUMN     "submittedVendStatus" TEXT;

-- AlterTable
ALTER TABLE "VendRecord" DROP COLUMN "status",
ADD COLUMN     "processingStatus" "VendProcessingStatus" NOT NULL DEFAULT 'Pending',
ADD COLUMN     "vendStatus" "VendStatus" NOT NULL;

-- AlterTable
ALTER TABLE "VendRecordRevision" ADD COLUMN     "newVendStatus" "VendStatus" NOT NULL,
ADD COLUMN     "previousVendStatus" "VendStatus" NOT NULL;

-- CreateIndex
CREATE INDEX "VendRecord_discoAdminId_processingStatus_idx" ON "VendRecord"("discoAdminId", "processingStatus");
