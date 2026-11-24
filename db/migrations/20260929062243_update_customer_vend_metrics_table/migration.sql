/*
  Warnings:

  - You are about to drop the column `lastCalculatedAt` on the `CustomerVendMetrics` table. All the data in the column will be lost.
  - You are about to drop the column `medianVendAmountKobo` on the `CustomerVendMetrics` table. All the data in the column will be lost.
  - You are about to drop the column `vendFrequency` on the `CustomerVendMetrics` table. All the data in the column will be lost.
  - You are about to alter the column `failedVendRatio` on the `CustomerVendMetrics` table. The data in that column could be lost. The data in that column will be cast from `Integer` to `Decimal(7,4)`.
  - Added the required column `featureAsOfDate` to the `CustomerVendMetrics` table without a default value. This is not possible if the table is not empty.
  - Added the required column `meterStatus` to the `CustomerVendMetrics` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalVends` to the `CustomerVendMetrics` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "CustomerVendMetrics" DROP COLUMN "lastCalculatedAt",
DROP COLUMN "medianVendAmountKobo",
DROP COLUMN "vendFrequency",
ADD COLUMN     "featureAsOfDate" DATE NOT NULL,
ADD COLUMN     "featureDefinitionVersion" TEXT NOT NULL DEFAULT 'aple_live_v2',
ADD COLUMN     "medianVendAmountNaira" DECIMAL(18,6),
ADD COLUMN     "meterStatus" TEXT NOT NULL,
ADD COLUMN     "totalVends" INTEGER NOT NULL,
ALTER COLUMN "daysSinceLastVend" DROP NOT NULL,
ALTER COLUMN "vendAmountVolatility" DROP NOT NULL,
ALTER COLUMN "vendAmountVolatility" DROP DEFAULT,
ALTER COLUMN "vendAmountVolatility" SET DATA TYPE DECIMAL(18,6),
ALTER COLUMN "interVendVarianceDays" DROP NOT NULL,
ALTER COLUMN "interVendVarianceDays" DROP DEFAULT,
ALTER COLUMN "interVendVarianceDays" SET DATA TYPE DECIMAL(18,6),
ALTER COLUMN "failedVendRatio" SET DEFAULT 0,
ALTER COLUMN "failedVendRatio" SET DATA TYPE DECIMAL(7,4);
