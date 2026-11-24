-- AlterEnum
ALTER TYPE "AdminType" ADD VALUE 'FINANCE_HOUSE';

-- AlterEnum
ALTER TYPE "UserType" ADD VALUE 'FINANCE_HOUSE';

-- CreateTable
CREATE TABLE "FinanceHouses" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "lastInteraction" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "amountSpent" DECIMAL(65,30),
    "status" TEXT NOT NULL,
    "mail" TEXT NOT NULL,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceHouses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceHouses_userId_key" ON "FinanceHouses"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceHouses_name_key" ON "FinanceHouses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceHouses_mail_key" ON "FinanceHouses"("mail");

-- AddForeignKey
ALTER TABLE "FinanceHouses" ADD CONSTRAINT "FinanceHouses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
