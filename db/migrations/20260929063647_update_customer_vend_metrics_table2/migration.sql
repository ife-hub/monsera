-- AlterTable
ALTER TABLE "CustomerVendMetrics" ADD COLUMN     "customerType" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "hasTransactions" BOOLEAN,
ADD COLUMN     "tariffBand" "TariffBand",
ADD COLUMN     "tariffClass" TEXT,
ADD COLUMN     "vendCountLast365Days" INTEGER;
