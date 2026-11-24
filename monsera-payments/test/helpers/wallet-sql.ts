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

/**
 * Stand-ins for lib/wallet-a.ts: the "take from one Wallet A row" statement
 * (debitWalletA) and the Wallet A total (walletABalanceKobo). Unit tests use a
 * single Wallet A row; sub-wallets are covered by the real-database tests.
 */
export const isDebitWalletASql = (strings: TemplateStringsArray) => strings.join('?').includes('WITH pick AS');
export const isWalletATotalSql = (strings: TemplateStringsArray) => strings.join('?').includes('SUM(balance)');

export async function fakeDebitWalletA(tx: any, balancesNaira: Record<number, number>, values: unknown[]) {
  // Parameter order in debitWalletA's take statement: the row choice (a
  // nested Prisma.sql whose first value is Wallet A's or the chosen row's id),
  // then the amount (twice), type, -amount, description, reference.
  const pick = values[0] as { values?: unknown[] };
  const walletId = Number(pick?.values?.[0] ?? 1);
  const amountKobo = Number(values[1]);
  const type = values[3] as string;
  const description = values[5] as string;
  const referenceId = (values[6] as string | null) ?? null;

  const currentKobo = Math.round((balancesNaira[walletId] ?? 0) * 100);
  if (currentKobo < amountKobo) return [];
  balancesNaira[walletId] = (currentKobo - amountKobo) / 100;

  await tx.wallet?.update?.({ where: { id: walletId }, data: { balance: { increment: new Prisma.Decimal(-amountKobo).div(100) }, updatedAt: new Date() } });
  const record = (await tx.walletTransaction?.create?.({ data: { walletId, type, amountKobo: -amountKobo, description, referenceId } })) ?? {};
  return [{
    id: walletId, balance: new Prisma.Decimal(currentKobo - amountKobo).div(100),
    recordId: record.id ?? 1, recordType: type, recordAmountKobo: -amountKobo, recordDescription: description,
    recordReferenceId: referenceId, recordCreatedAt: new Date(),
  }];
}

export const walletATotalRows = (balancesNaira: Record<number, number>, walletAId = 1) => [{ kobo: Math.round((balancesNaira[walletAId] ?? 0) * 100) }];
