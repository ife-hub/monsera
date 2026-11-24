/*
  Warnings:

  - You are about to drop the column `partnerVendId` on the `VendIngestionFailure` table. All the data in the column will be lost.
  - You are about to drop the column `rawPayload` on the `VendIngestionFailure` table. All the data in the column will be lost.
  - You are about to drop the column `rawPayload` on the `VendRecord` table. All the data in the column will be lost.
  - You are about to drop the column `newPayload` on the `VendRecordRevision` table. All the data in the column will be lost.
  - You are about to drop the column `previousPayload` on the `VendRecordRevision` table. All the data in the column will be lost.
  - Added the required column `vendType` to the `VendRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `newAmountKobo` to the `VendRecordRevision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `newVendType` to the `VendRecordRevision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `newVendedAt` to the `VendRecordRevision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `previousAmountKobo` to the `VendRecordRevision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `previousVendType` to the `VendRecordRevision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `previousVendedAt` to the `VendRecordRevision` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "VendType" AS ENUM ('PREPAID_TOKEN', 'POSTPAID_PAYMENT', 'TOKEN_TOP_UP');

-- AlterTable
ALTER TABLE "VendIngestionFailure" DROP COLUMN "partnerVendId",
DROP COLUMN "rawPayload",
ADD COLUMN     "submittedAmountKobo" TEXT,
ADD COLUMN     "submittedMeterToken" TEXT,
ADD COLUMN     "submittedPartnerVendId" TEXT,
ADD COLUMN     "submittedVendType" TEXT,
ADD COLUMN     "submittedVendedAt" TEXT,
ADD COLUMN     "unrecognizedFields" TEXT;

-- AlterTable
ALTER TABLE "VendRecord" DROP COLUMN "rawPayload",
DROP COLUMN "vendType",
ADD COLUMN     "vendType" "VendType" NOT NULL;

-- AlterTable
ALTER TABLE "VendRecordRevision" DROP COLUMN "newPayload",
DROP COLUMN "previousPayload",
ADD COLUMN     "newAmountKobo" INTEGER NOT NULL,
ADD COLUMN     "newVendType" "VendType" NOT NULL,
ADD COLUMN     "newVendedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "previousAmountKobo" INTEGER NOT NULL,
ADD COLUMN     "previousVendType" "VendType" NOT NULL,
ADD COLUMN     "previousVendedAt" TIMESTAMP(3) NOT NULL;
