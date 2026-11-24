/*
  Warnings:

  - You are about to drop the `MonseraEarningWallet` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "MonseraEarningWallet";

-- CreateTable
CREATE TABLE "MonseraEarnings" (
    "id" SERIAL NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "customerId" INTEGER NOT NULL,
    "aggregatorId" INTEGER NOT NULL,
    "discoAdminId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonseraEarnings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MonseraEarnings" ADD CONSTRAINT "MonseraEarnings_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "Aggregators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonseraEarnings" ADD CONSTRAINT "MonseraEarnings_discoAdminId_fkey" FOREIGN KEY ("discoAdminId") REFERENCES "DiscoAdmins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonseraEarnings" ADD CONSTRAINT "MonseraEarnings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
