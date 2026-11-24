-- Ledger invariants that must hold after any amount of concurrent traffic.
-- Each row is one check. On a database holding only stress data every
-- `violations` value must be 0; on an existing database run-local.sh
-- requires each value to be unchanged by the run instead (older data may
-- already violate a check). Read-only: safe to run against any environment.

WITH
recovery_sums AS (
  SELECT "obligationId", SUM("amountKobo") AS amt, SUM("principalKobo") AS principal, SUM("serviceKobo") AS service
  FROM "ObligationRecovery" GROUP BY "obligationId"
),
open_per_customer AS (
  SELECT "customerId", COUNT(*) AS n FROM "Obligation"
  WHERE status IN ('Current', 'Watch', 'Delayed', 'Default') AND "remainingKobo" > 0
  GROUP BY "customerId"
),
ledger AS (
  SELECT "walletId", SUM("amountKobo") AS kobo FROM "WalletTransaction" GROUP BY "walletId"
),
remaining_per_customer AS (
  SELECT "customerId", SUM("remainingKobo") AS kobo FROM "Obligation" GROUP BY "customerId"
),
repayment_sums AS (
  SELECT "recoveryTransactionId" AS txn, SUM("amountKobo") AS kobo FROM "ObligationRecovery" GROUP BY 1
)
SELECT check_name, violations FROM (
  SELECT 1 AS ord, 'obligation remaining within [0, obligation]' AS check_name,
         COUNT(*) FILTER (WHERE "remainingKobo" < 0 OR "remainingKobo" > "obligationKobo") AS violations
  FROM "Obligation"
  UNION ALL
  SELECT 2, 'recovered = obligation - remaining (no double application)',
         COUNT(*) FILTER (WHERE "recoveredKobo" <> "obligationKobo" - "remainingKobo")
  FROM "Obligation"
  UNION ALL
  SELECT 3, 'recovery rows sum to obligation.recoveredKobo',
         COUNT(*) FILTER (WHERE COALESCE(r.amt, 0) <> o."recoveredKobo")
  FROM "Obligation" o LEFT JOIN recovery_sums r ON r."obligationId" = o.id
  UNION ALL
  SELECT 4, 'principal + service recovered = recovered',
         COUNT(*) FILTER (WHERE "principalRecoveredKobo" + "serviceRecoveredKobo" <> "recoveredKobo")
  FROM "Obligation"
  UNION ALL
  SELECT 5, 'discharged iff nothing remains',
         COUNT(*) FILTER (WHERE (status = 'Discharged') <> ("remainingKobo" = 0))
  FROM "Obligation"
  UNION ALL
  SELECT 6, 'at most one open obligation per meter (maxConcurrentObligations = 1)',
         COUNT(*) FILTER (WHERE n > 1)
  FROM open_per_customer
  UNION ALL
  SELECT 7, 'wallet balance = sum of its ledger rows (kobo of gap, summed)',
         COALESCE(SUM(ABS(ROUND(COALESCE(w.balance, 0) * 100) - COALESCE(l.kobo, 0))), 0)
  FROM "Wallet" w LEFT JOIN ledger l ON l."walletId" = w.id
  UNION ALL
  SELECT 8, 'no wallet below zero',
         COUNT(*) FILTER (WHERE balance < 0)
  FROM "Wallet"
  UNION ALL
  SELECT 9, 'customer.outstanding = sum of remaining obligations',
         COUNT(*) FILTER (WHERE ROUND(c.outstanding * 100) <> COALESCE(r.kobo, 0))
  FROM "Customers" c LEFT JOIN remaining_per_customer r ON r."customerId" = c.id
  UNION ALL
  SELECT 10, 'every recovery linked to its repayment transaction',
         COUNT(*) FILTER (WHERE "recoveryTransactionId" = 0)
  FROM "ObligationRecovery"
  UNION ALL
  SELECT 11, 'repayment transaction amount = its recovery rows',
         COUNT(*) FILTER (WHERE t."obligationKobo" <> COALESCE(s.kobo, -1))
  FROM "Transactions" t LEFT JOIN repayment_sums s ON s.txn = t.id
  WHERE t."transactionType" = 'repayment'
  UNION ALL
  SELECT 12, 'one disbursement ledger row per debit, same amount',
         ABS((SELECT COUNT(*) FROM "WalletTransaction" WHERE type = 'disbursement')
           - (SELECT COUNT(*) FROM "Transactions" WHERE "transactionType" = 'debit'))
       + CASE WHEN (SELECT -COALESCE(SUM("amountKobo"), 0) FROM "WalletTransaction" WHERE type = 'disbursement')
                 = (SELECT COALESCE(SUM("disbursedKobo"), 0) FROM "Transactions" WHERE "transactionType" = 'debit')
              THEN 0 ELSE 1 END
  UNION ALL
  SELECT 14, 'every approved decision has its debit transaction, and every debit an approved decision (§6.1)',
         (SELECT COUNT(*) FROM "DecisionLog" d WHERE d.decision = 'approved'
             AND NOT EXISTS (SELECT 1 FROM "Transactions" t WHERE t."transactionId" = d."correlationId" AND t."transactionType" = 'debit'))
       + (SELECT COUNT(*) FROM "Transactions" t WHERE t."transactionType" = 'debit'
             AND NOT EXISTS (SELECT 1 FROM "DecisionLog" d WHERE d."correlationId" = t."transactionId" AND d.decision = 'approved'))
  UNION ALL
  SELECT 15, 'every obligation is for a pilot tier, with disbursed + service = obligation (§2)',
         COUNT(*) FILTER (WHERE "obligationKobo" NOT IN (200000, 400000, 700000)
                             OR "disbursedKobo" + "serviceKobo" <> "obligationKobo"
                             OR "disbursedKobo" <> FLOOR("obligationKobo"::numeric * 10000 / (10000 + "rateBps")))
  FROM "Obligation"
  UNION ALL
  SELECT 13, 'debit marked paid iff its obligation is discharged',
         COUNT(*) FILTER (WHERE (t."paymentStatus" = 'paid') <> (o.status = 'Discharged'))
  FROM "Obligation" o JOIN "Transactions" t ON t.id = o."transactionId"
) checks
ORDER BY ord;
