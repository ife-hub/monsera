-- AlterTable
ALTER TABLE "Transactions" ADD COLUMN     "disbursedKobo" INTEGER,
ADD COLUMN     "obligationKobo" INTEGER,
ADD COLUMN     "rateBps" INTEGER,
ADD COLUMN     "serviceKobo" INTEGER;
