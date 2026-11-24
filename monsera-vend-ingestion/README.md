# monsera-vend-ingestion

Vend records pushed by discos (`POST /api/partners/vends`, `POST /api/partners/vends/batch`, up to 500 per batch, per-row results), the vend-metrics worker that turns them into the scoring features payments reads (`CustomerVendMetrics`), and the daily vend failure report (03:00 WAT, `CRON_VEND_FAILURE_REPORT`), delivered through monsera-notifications. Failures are marked reported only after delivery succeeds.

Environment: `DATABASE_URL`, `REDIS_URL`, `BULLMQ_PREFIX`, `JWT_SECRET`, `NOTIFICATIONS_URL`, `INTERNAL_API_KEY`, optional `RUN_WORKERS=false`, `SENTRY_DSN`.

```bash
npm ci && npm test && npm run start:dev
```
