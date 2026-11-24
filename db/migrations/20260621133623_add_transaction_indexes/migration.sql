-- CreateIndex
CREATE INDEX "Transactions_customerId_aggregatorId_paymentStatus_idx" ON "Transactions"("customerId", "aggregatorId", "paymentStatus");

-- CreateIndex
CREATE INDEX "Transactions_transactionType_transactionStatus_paymentStatu_idx" ON "Transactions"("transactionType", "transactionStatus", "paymentStatus");
