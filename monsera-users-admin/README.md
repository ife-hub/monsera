# monsera-users-admin

Sign-in (`POST /api/auth/login`, throttled per email and per client IP through Redis), the current user (`/api/auth/me`), password changes (`/api/auth/change-password`, which revoke tokens issued before), users and user types.

Every service checks a token against the database on each request, so a deactivated account or a token older than the last password change is refused everywhere.

Environment: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, optional `SENTRY_DSN`.

```bash
npm ci && npm test && npm run start:dev
```
