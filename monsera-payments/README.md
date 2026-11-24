# monsera-payments

Advances (`POST /api/transactions/debit`), recoveries (`POST /api/transactions/credit`), transactions, wallets A/B/C, the float ledger, credit and recovery-window parameters, burn rates, cohort, clock suspensions, and the scheduled money jobs. All money movement on the platform happens here.

The handlers in `src/app/api` and the code in `src/lib` are monsera-backend's, unchanged apart from import paths; `src/route-adapter.ts` mounts them on Nest's Express server.

Scheduled jobs (`src/lib/scheduled-jobs.ts`, West Africa Time, run once per tick across instances): obligation status 00:05, daily sweep 00:15, settlement 00:30, reconciliation 00:45, monthly reconciliation 02:00 on the 1st, idempotency cleanup 03:30. Override with `CRON_OBLIGATION_STATUS`, `CRON_DAILY_SWEEP`, `CRON_SETTLEMENT`, `CRON_RECONCILIATION`, `CRON_MONTHLY_RECONCILIATION`, `CRON_IDEMPOTENCY_CLEANUP` (cron pattern, or `off`). `GET /api/cron/<job>` with `Authorization: Bearer $CRON_SECRET` runs one by hand. `RUN_WORKERS=false` starts the HTTP API only.

Environment: `DATABASE_URL`, `REDIS_URL`, `BULLMQ_PREFIX`, `JWT_SECRET`, `WALLET_A_ID`, `WALLET_B_ID`, `WALLET_C_ID`, `SCORING_ENGINE_URL`, `SCORING_ENGINE_SECRET`, `CRON_SECRET`, optional `SENTRY_DSN`.

```bash
npm ci                     # also runs prisma generate
npm test                   # unit tests
TEST_DATABASE_URL=postgresql://… npm run test:integration   # ledger test; TRUNCATES that database
npm run start:dev
```
