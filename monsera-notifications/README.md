# monsera-notifications

Delivers what the other services report:

- `ops.alert` events (queue `payment-events`) → email to `ALERT_RECIPIENTS`, plus SMS to `ALERT_PHONE_NUMBERS` for critical ones. Each alert title is sent at most once per `ALERT_COOLDOWN_MINUTES` (default 360), across instances.
- `obligation.status_changed` to Delayed/Default → one digest email per `DIGEST_WINDOW_SECONDS` (default 60). Pending changes are kept in Redis, so a restart loses nothing.
- `POST /notifications/vend-failure-report` (header `X-Internal-Key: $INTERNAL_API_KEY`) → email to the disco.

No SMTP settings: emails are logged instead of sent. The SMS provider is not wired up yet (`src/sms/sms.service.ts`).

Environment: `REDIS_URL`, `BULLMQ_PREFIX`, `INTERNAL_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `ALERT_RECIPIENTS`, `ALERT_PHONE_NUMBERS`.

```bash
npm ci && npm test && npm run start:dev
```
