import { Prisma } from '@prisma/client';

/**
 * Unit-test stand-in for the single statement lib/wallets.ts adjustWallet
 * sends ("WITH updated AS (UPDATE "Wallet" ...) INSERT INTO "WalletTransaction" ...").
 *
 * Applies the same rule (a debit may not take the balance below zero),
 * keeps `balancesNaira` up to date, and reports the move through the tx
 * mock's wallet.update / walletTransaction.create, so tests can keep
 * asserting the money effects as before. The real SQL is covered by
 * test/integration/wallets.int.test.ts.
 */
export const isAdjustWalletSql = (strings: TemplateStringsArray) => strings.join('?').includes('WITH updated AS');

export async function fakeAdjustWallet(tx: any, balancesNaira: Record<number, number>, values: unknown[]) {
  // Parameter order in adjustWallet's query.
  const deltaKobo = Number(values[0]);
  const walletId = Number(values[1]);
  const type = values[4] as string;
  const description = values[6] as string;
  const referenceId = (values[7] as string | null) ?? null;

  const currentKobo = Math.round((balancesNaira[walletId] ?? 0) * 100);
  if (deltaKobo < 0 && currentKobo + deltaKobo < 0) return [];
  balancesNaira[walletId] = (currentKobo + deltaKobo) / 100;

  await tx.wallet?.update?.({ where: { id: walletId }, data: { balance: { increment: new Prisma.Decimal(deltaKobo).div(100) }, updatedAt: new Date() } });
  const record = (await tx.walletTransaction?.create?.({ data: { walletId, type, amountKobo: deltaKobo, description, referenceId } })) ?? {};

  return [{
    id: walletId, walletType: 'A', balance: new Prisma.Decimal(currentKobo + deltaKobo).div(100), createdAt: new Date(), updatedAt: new Date(),
    recordId: record.id ?? 1, recordType: type, recordAmountKobo: deltaKobo, recordDescription: description,
    recordReferenceId: referenceId, recordCreatedAt: new Date(),
  }];
}
