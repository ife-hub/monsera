-- Wallet A sub-wallets: extra "Wallet" rows that together with Wallet A make
-- up Wallet A's balance, so several advances can commit at once instead of
-- queueing on one row lock. A sub-wallet points at Wallet A; Wallet A itself
-- has no parent. Existing rows are unaffected.
ALTER TABLE "Wallet" ADD COLUMN "parentWalletId" INTEGER;
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_parentWalletId_fkey"
  FOREIGN KEY ("parentWalletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Wallet_parentWalletId_idx" ON "Wallet"("parentWalletId");
