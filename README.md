# Monsera

Monsera's backend as a gateway plus five services, carrying over the behaviour of `monsera-backend` (the pilot platform specification, its money rules and its tests) unchanged.

```
                 partners / frontend
                         │  https
                  ┌──────▼──────┐   per-key rate limit, CORS, token signature
                  │   gateway   │   streams /api/* to the owning service
                  └──┬──┬──┬──┬─┘
        ┌────────────┘  │  │  └──────────────┐
┌───────▼──────┐ ┌──────▼───────┐ ┌──────────▼─────┐ ┌──────────┐
│   payments   │ │vend-ingestion│ │  users-admin   │ │  admin   │
│ money + jobs │ │ vends,metrics│ │ sign-in, users │ │ partners │
└──────┬───────┘ └──────┬───────┘ └───────┬────────┘ └────┬─────┘
       │  events (Redis/BullMQ)    HTTP (internal key)    │
       └─────────────► notifications ◄────────┘           │
                     email / SMS alerts                   │
       all four ─────────────► Postgres (one schema, db/) ◄┘
```

| Service | Port | Owns |
|---|---|---|
| `monsera-gateway` | 3000 | The only public service. Routes `/api/*`, CORS, rate limiting. |
| `monsera-payments` | 3001 | Advances (debit), recoveries (credit), wallets A/B/C, float ledger, transactions, credit and recovery-window parameters, burn rates, cohort, clock suspensions, and the scheduled money jobs. |
| `monsera-users-admin` | 3002 | Sign-in (throttled), current user, password changes, users, user types. |
| `monsera-vend-ingestion` | 3003 | Vend records from discos, the vend-metrics worker (scoring features), the daily failure report. |
| `monsera-admin` | 3004 | Aggregators, discos, finance houses, customers, employees, roles, system admins, audits, feature flags, loan thresholds, meter state. |
| `monsera-notifications` | 3005 | Ops alerts and status digests (email, SMS for critical), vend failure reports to discos. |

## Same API as monsera-backend

Every path `monsera-backend` served is served at the same URL through the gateway (`/api/transactions/debit`, `/api/aggregators/:id`, ...), with the same request and response bodies, so the frontend and partner integrations do not change. The services run `monsera-backend`'s route handlers and `lib/` code as they are, behind a small adapter (`src/route-adapter.ts` with `src/lib/next-server.ts` and `src/lib/monitoring.ts`), and carry its tests (`monsera-payments` alone runs 223 unit tests plus the ledger integration test against Postgres).

Changes from `monsera-backend`:

- **Scheduled jobs run inside payments** (BullMQ job schedulers, West Africa Time, once per tick however many instances run). Defaults: obligation status 00:05, sweep 00:15, settlement 00:30, reconciliation 00:45, monthly reconciliation 02:00 on the 1st, idempotency cleanup 03:30. Override with `CRON_*` variables or turn one off with `off`; `/api/cron/*` still runs a job by hand (`CRON_SECRET`).
- **Alerts reach people**: errors and warnings go to notifications as `ops.alert` events (email; SMS for critical), and obligations moving to Delayed/Default arrive as one digest email per minute instead of one alert each.
- **Vend failure reports are delivered** (they were a logging stub) and only marked reported once delivered.
- **Partners can no longer read each other's records**: `aggregators/:id`, `discos/:id`, `finance/:id` and `float-ledger/:id` are limited to staff or the partner itself; the discos list shows partners only id, name and status; meter state, loan thresholds, roles and the aggregators list are staff only; wallet balances are staff and finance houses only.
- **A repayment never hangs on Redis**: the post-commit queue add times out after 2s.
- **Wallet A is split into sub-wallets** (8 by default) so advances pay out in parallel instead of queueing on one locked row; reconciliation counts all of them as Wallet A (see `monsera-payments/README.md`).
- **Disco and aggregator totals are updated within seconds, not inside each advance**, so advances through one disco (APLE) don't queue on its row; the advance's own response stays exact (see `monsera-payments/README.md`).

## Data: one schema, declared owners

There is one Postgres database and one schema, `db/schema.prisma`, with every migration in `db/migrations` (identical to `monsera-backend`'s, so an existing `monsera-backend` database is already up to date). Only `db/` runs migrations; services never do. Each service keeps a generated copy of the schema for `prisma generate`:

```bash
npm run schema:sync     # after editing db/schema.prisma
npm run schema:check    # CI fails if a copy has drifted
```

Who writes what (derived from the code; reads are noted only across boundaries):

| Tables | Written by |
|---|---|
| Transactions, Obligation, ObligationRecovery, ObligationSuspension, DecisionLog, Wallet, WalletTransaction, Float_Ledger, MonseraEarnings, IdempotencyRecord, CreditParameters, RecoveryWindowParameters, BurnRate, CohortMeter, ReconciliationRun | **payments** only |
| VendRecord, VendRecordRevision, VendIngestionFailure, CustomerVendMetrics | **vend-ingestion** only (payments reads CustomerVendMetrics for scoring) |
| FinanceHouse, Employee, Role, SystemAdmin, Meter_State, Loan_Threshold, FeatureFlag | **admin** only (payments reads FeatureFlag) |
| Aggregator, DiscoAdmin, Customer | **admin** for profiles; **payments** for `outstanding`, `balance`, `lastInteraction`, and creates a Customer on its first advance |
| User | **users-admin** (sign-in, passwords, accounts); **admin** creates the login with a new partner or employee |
| Audit | every service appends; the database refuses updates and deletes (append-only triggers) |

Every money movement goes through payments. The next step towards fully separate data is a Postgres role per service with `GRANT`s matching this table, so the database enforces it.

## Run it locally

```bash
cp .env.example .env              # set JWT_SECRET, CRON_SECRET, INTERNAL_API_KEY
docker compose up --build         # Postgres, Redis, migrations, all services, mock scoring engine
curl http://localhost:3000/api/health
```

Without Docker: start Postgres and Redis, then `npm run install:all`, `npm run migrate`, and `npm run dev` (every service in watch mode; each reads its environment, see `.env.example`).

Tests: `npm run test:all` and `npm run typecheck:all`; the ledger integration test needs a database: `cd monsera-payments && TEST_DATABASE_URL=… npm run test:integration`. Load test against a running platform: `stress/` (see `stress/stress-test.mjs`).

## Deploy

- **Migrations first**: run `db/` (its Dockerfile runs `prisma migrate deploy`) as a pre-deploy job.
- **Only the gateway is public.** Run the other services on the private network (on DigitalOcean App Platform: internal services with no HTTP route) and point the gateway at them with `PAYMENTS_URL`, `USERS_ADMIN_URL`, `VEND_INGESTION_URL`, `ADMIN_URL`.
- **Same secrets everywhere**: `JWT_SECRET` (gateway and all services), `INTERNAL_API_KEY` (vend-ingestion and notifications), `DATABASE_URL`, `REDIS_URL` and `BULLMQ_PREFIX` (every service in one environment; give each environment its own prefix or Redis database if they share a Redis).
- **Workers**: payments and vend-ingestion run their queue workers and schedules unless `RUN_WORKERS=false`; keep at least one instance of each with workers on.
- Each service's `GET /health` checks its database; the gateway's `GET /api/health` reports every service.
