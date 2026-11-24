import IORedis from 'ioredis';
import * as Sentry from './monitoring';

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const UPSTASH_QUOTA_PATTERN = /max (daily |monthly )?request limit exceeded/i;

connection.on('error', (error: Error) => {
  const isQuotaExceeded = UPSTASH_QUOTA_PATTERN.test(error.message);

  Sentry.captureException(error, {
    tags: { component: 'redis-connection', quotaExceeded: String(isQuotaExceeded) },
    level: isQuotaExceeded ? 'fatal' : 'error',
  });

  if (isQuotaExceeded) {
    console.error(
      'ALERT: Upstash request quota exceeded — queue workers will stop processing jobs until the quota resets or the plan is upgraded.',
      error
    );
  }
});

export default connection;