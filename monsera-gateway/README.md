# monsera-gateway

The only public service. Streams every `/api/*` request to the service that owns it (table in `src/proxy/routes.ts`) and the response back unchanged, including headers such as `Retry-After` and `Content-Disposition`.

- Checks the bearer token's signature (services check the account again against the database). Login and `/api/cron/*` pass without a token.
- Rate limit per partner API key, else per user, else per IP, shared across instances through Redis (`RATE_LIMIT_PER_MINUTE`, default 1200; fails open).
- Sets `X-Forwarded-For`/`X-Real-IP` from the load balancer's address (`TRUST_PROXY_HOPS`, default 1) and adds `X-Request-Id`.
- 2 MB body limit (`MAX_BODY_BYTES`); upstream timeout 15s, 45s for debit, credit and cron (`UPSTREAM_TIMEOUT_MS`, `MONEY_UPSTREAM_TIMEOUT_MS`).
- `GET /health` (gateway alive), `GET /api/health` (every service and its database).

Environment: `JWT_SECRET`, `PAYMENTS_URL`, `USERS_ADMIN_URL`, `VEND_INGESTION_URL`, `ADMIN_URL`, `REDIS_URL`, `CORS_ORIGINS`, `PORT`.

```bash
npm ci && npm test && npm run start:dev
```
