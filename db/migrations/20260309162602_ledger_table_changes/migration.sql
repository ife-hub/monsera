-- AlterTable
ALTER TABLE "Float_Ledger" ADD COLUMN     "discoAdminId" INTEGER;

-- AddForeignKey
ALTER TABLE "Float_Ledger" ADD CONSTRAINT "Float_Ledger_discoAdminId_fkey" FOREIGN KEY ("discoAdminId") REFERENCES "DiscoAdmins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
