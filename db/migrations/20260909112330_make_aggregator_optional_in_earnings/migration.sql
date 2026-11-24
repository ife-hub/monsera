-- DropForeignKey
ALTER TABLE "MonseraEarnings" DROP CONSTRAINT "MonseraEarnings_aggregatorId_fkey";

-- AlterTable
ALTER TABLE "MonseraEarnings" ALTER COLUMN "aggregatorId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "MonseraEarnings" ADD CONSTRAINT "MonseraEarnings_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "Aggregators"("id") ON DELETE SET NULL ON UPDATE CASCADE;
