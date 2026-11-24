-- CreateTable
CREATE TABLE "MonseraEarningWallet" (
    "id" SERIAL NOT NULL,
    "balance" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonseraEarningWallet_pkey" PRIMARY KEY ("id")
);
