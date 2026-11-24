/*
  Warnings:

  - You are about to drop the column `meterNumber` on the `Meter_State` table. All the data in the column will be lost.
  - Added the required column `meterToken` to the `Meter_State` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Meter_State" DROP COLUMN "meterNumber",
ADD COLUMN     "meterToken" TEXT NOT NULL DEFAULT 'TEST-METER-0000';
