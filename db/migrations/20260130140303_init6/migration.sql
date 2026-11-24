-- AlterTable
ALTER TABLE "Float_Ledger" ADD COLUMN     "attachmentUrl" TEXT,
ADD COLUMN     "financeHouseId" INTEGER DEFAULT 9;

-- AddForeignKey
ALTER TABLE "Float_Ledger" ADD CONSTRAINT "Float_Ledger_financeHouseId_fkey" FOREIGN KEY ("financeHouseId") REFERENCES "FinanceHouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
