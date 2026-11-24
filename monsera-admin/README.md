# monsera-admin

Back-office records: aggregators and discos (including API key regeneration), finance houses, customers, employees, roles, system admins, audits, feature flags, loan thresholds and meter state.

Access: staff (Monsera admins, employees) see everything; a partner sees only its own record (`src/lib/record-access.ts`) and only customers that took an advance through it (`src/lib/access-scope.ts`). API keys and password hashes never leave through responses (`src/lib/safe-select.ts`).

Environment: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, optional `SENTRY_DSN`.

```bash
npm ci && npm test && npm run start:dev
```
