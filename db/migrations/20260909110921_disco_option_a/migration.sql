-- DropForeignKey
ALTER TABLE "Transactions" DROP CONSTRAINT "Transactions_aggregatorId_fkey";

-- AlterTable
ALTER TABLE "IdempotencyRecord" ADD COLUMN     "discoAdminId" INTEGER,
ALTER COLUMN "aggregatorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Transactions" ALTER COLUMN "aggregatorId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Transactions" ADD CONSTRAINT "Transactions_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "Aggregators"("id") ON DELETE SET NULL ON UPDATE CASCADE;
