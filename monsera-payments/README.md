# monsera-payments

Advances (`POST /api/transactions/debit`), recoveries (`POST /api/transactions/credit`), transactions, wallets A/B/C, the float ledger, credit and recovery-window parameters, burn rates, cohort, clock suspensions, and the scheduled money jobs. All money movement on the platform happens here.

The handlers in `src/app/api` and the code in `src/lib` are monsera-backend's, unchanged apart from import paths; `src/route-adapter.ts` mounts them on Nest's Express server.

Scheduled jobs (`src/lib/scheduled-jobs.ts`, West Africa Time, run once per tick across instances): obligation status 00:05, daily sweep 00:15, settlement 00:30, reconciliation 00:45, monthly reconciliation 02:00 on the 1st, idempotency cleanup 03:30, Wallet A rebalance every 10 minutes. Override with `CRON_OBLIGATION_STATUS`, `CRON_DAILY_SWEEP`, `CRON_SETTLEMENT`, `CRON_RECONCILIATION`, `CRON_MONTHLY_RECONCILIATION`, `CRON_IDEMPOTENCY_CLEANUP` (cron pattern, or `off`). `GET /api/cron/<job>` with `Authorization: Bearer $CRON_SECRET` runs one by hand. `RUN_WORKERS=false` starts the HTTP API only.

**Wallet A sub-wallets** (`src/lib/wallet-a.ts`). Every approved advance takes money from Wallet A, and a wallet row stays locked until its transaction commits, so with one row advances pay out one at a time. Wallet A is therefore `WALLET_A_SHARDS` rows (default 8): Wallet A itself plus sub-wallets created at start-up (`Wallet.parentWalletId`). An advance takes from any free row that can cover it, so up to 8 commit at once. Money arriving on Wallet A (sweep, float allocation, top-up) is spread over the rows straight away and every 10 minutes (`CRON_WALLET_A_REBALANCE`), as `rebalance` ledger rows that net to zero; if the money is spread too thin for an advance, it is gathered first. Wallet A's balance, the controlling identity and the monthly checks count all the rows as Wallet A, and `GET /api/wallet/<Wallet A>` shows the total with the sub-wallets listed. Sub-wallets cannot be topped up or debited directly.

**Disco and aggregator totals** (`src/lib/partner-totals.ts`). A disco's balance and outstanding, and an aggregator's outstanding, are running totals that every advance and repayment through that partner changes. Updating the partner's row inside each money transaction made every advance through one disco (APLE) queue on that row. Advances and repayments now record the change as a `PartnerBalanceChange` row (an insert never waits), and payments adds the pending changes into the partner rows every 2 seconds (`PARTNER_TOTALS_FOLD_MS`; on every worker instance, and once more on shutdown). The rows may lag by those seconds; nothing approves or refuses an advance from them (Wallet A is the only funding check), reconciliation does not use them, and the disco balance returned with an advance is exact (row plus pending changes).

**Settings cache** (`src/lib/settings-cache.ts`). Feature flags, credit parameters, recovery-window parameters and burn rates are read on every advance but rarely change, so each payments instance caches them for `SETTINGS_CACHE_MS` (default 5 seconds). A change takes effect within that time on every instance, and at once on the instance that saved it. A failed read is never cached.

Environment: `DATABASE_URL`, `REDIS_URL`, `BULLMQ_PREFIX`, `JWT_SECRET`, `WALLET_A_ID`, `WALLET_B_ID`, `WALLET_C_ID`, `WALLET_A_SHARDS`, `PARTNER_TOTALS_FOLD_MS`, `SETTINGS_CACHE_MS`, `SCORING_ENGINE_URL`, `SCORING_ENGINE_SECRET`, `CRON_SECRET`, optional `SENTRY_DSN`.

```bash
npm ci                     # also runs prisma generate
npm test                   # unit tests
TEST_DATABASE_URL=postgresql://… npm run test:integration   # ledger test; TRUNCATES that database
npm run start:dev
```
