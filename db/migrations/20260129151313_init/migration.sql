-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('MONSERA_ADMIN', 'DISCO_ADMIN', 'EMPLOYEE', 'AGGREGATOR', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "AdminType" AS ENUM ('MONSERA_ADMIN', 'DISCO_ADMIN', 'AGGREGATOR');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userType" "UserType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemAdmin" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "adminType" "AdminType" NOT NULL,
    "permissions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transactions" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "transactionId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "transactionType" TEXT NOT NULL,
    "transactionStatus" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "aggregatorId" INTEGER NOT NULL,
    "discoAdminId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meter_State" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "meterNumber" TEXT NOT NULL,
    "state" TEXT NOT NULL,

    CONSTRAINT "Meter_State_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Float_Ledger" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "referenceId" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "type" TEXT NOT NULL,
    "currentFloatBalance" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "Float_Ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan_Threshold" (
    "id" SERIAL NOT NULL,
    "minimum" DECIMAL(65,30) NOT NULL,
    "maximum" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "Loan_Threshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customers" (
    "id" SERIAL NOT NULL,
    "lastInteraction" TIMESTAMP(3) NOT NULL,
    "meterNumber" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "outstanding" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "dateAdded" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAggregators" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "aggregatorId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CustomerAggregators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerDiscoAdmins" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "discoAdminId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CustomerDiscoAdmins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Aggregators" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "lastInteraction" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "outstanding" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL,
    "mail" TEXT NOT NULL,
    "logoUrl" TEXT,
    "apiKey" TEXT NOT NULL,
    "balance" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Aggregators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoAdmins" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "lastInteraction" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mail" TEXT NOT NULL,
    "logoUrl" TEXT,
    "apiKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoAdmins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Roles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "canViewTransactions" BOOLEAN NOT NULL DEFAULT false,
    "canManageTransactions" BOOLEAN NOT NULL DEFAULT false,
    "canViewUsers" BOOLEAN NOT NULL DEFAULT false,
    "canManageUsers" BOOLEAN NOT NULL DEFAULT false,
    "canBlacklistUsers" BOOLEAN NOT NULL DEFAULT false,
    "canActivateUsers" BOOLEAN NOT NULL DEFAULT false,
    "canViewScoringEngine" BOOLEAN NOT NULL DEFAULT false,
    "canEditThreshold" BOOLEAN NOT NULL DEFAULT false,
    "canValidateLoans" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employees" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "roleId" INTEGER NOT NULL,
    "userId" INTEGER,

    CONSTRAINT "Employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "employeeName" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "userId" INTEGER,
    "meterId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "Audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "SystemAdmin_userId_key" ON "SystemAdmin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Transactions_transactionId_key" ON "Transactions"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Customers_meterNumber_key" ON "Customers"("meterNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAggregators_customerId_aggregatorId_key" ON "CustomerAggregators"("customerId", "aggregatorId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDiscoAdmins_customerId_discoAdminId_key" ON "CustomerDiscoAdmins"("customerId", "discoAdminId");

-- CreateIndex
CREATE UNIQUE INDEX "Aggregators_userId_key" ON "Aggregators"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Aggregators_name_key" ON "Aggregators"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Aggregators_mail_key" ON "Aggregators"("mail");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoAdmins_userId_key" ON "DiscoAdmins"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoAdmins_name_key" ON "DiscoAdmins"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoAdmins_mail_key" ON "DiscoAdmins"("mail");

-- CreateIndex
CREATE UNIQUE INDEX "Roles_name_key" ON "Roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Employees_emailAddress_key" ON "Employees"("emailAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Employees_userId_key" ON "Employees"("userId");

-- AddForeignKey
ALTER TABLE "SystemAdmin" ADD CONSTRAINT "SystemAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transactions" ADD CONSTRAINT "Transactions_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "Aggregators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transactions" ADD CONSTRAINT "Transactions_discoAdminId_fkey" FOREIGN KEY ("discoAdminId") REFERENCES "DiscoAdmins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transactions" ADD CONSTRAINT "Transactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAggregators" ADD CONSTRAINT "CustomerAggregators_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "Aggregators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAggregators" ADD CONSTRAINT "CustomerAggregators_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerDiscoAdmins" ADD CONSTRAINT "CustomerDiscoAdmins_discoAdminId_fkey" FOREIGN KEY ("discoAdminId") REFERENCES "DiscoAdmins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerDiscoAdmins" ADD CONSTRAINT "CustomerDiscoAdmins_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Aggregators" ADD CONSTRAINT "Aggregators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoAdmins" ADD CONSTRAINT "DiscoAdmins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employees" ADD CONSTRAINT "Employees_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employees" ADD CONSTRAINT "Employees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Audit" ADD CONSTRAINT "Audit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
