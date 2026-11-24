/**
 * Error and alert reporting, with the two calls the code uses
 * (captureException, captureMessage).
 *
 *  - Always logs one structured line.
 *  - Sends to Sentry when SENTRY_DSN is set.
 *  - Publishes an `ops.alert` event to monsera-notifications (email, and SMS
 *    for critical) for exceptions and for messages at warning level or above.
 *    Notifications rate-limits repeats per alert title.
 */

type Level = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';
type Context = { level?: Level; tags?: Record<string, unknown>; extra?: Record<string, unknown>; [k: string]: unknown };

// Plain console (no framework import), so this loads in jobs, scripts and tests alike.
const logger = {
  log: (line: string) => console.log(`[Monitoring] ${line}`),
  warn: (line: string) => console.warn(`[Monitoring] ${line}`),
  error: (line: string, stack?: string) => console.error(`[Monitoring] ${line}${stack ? `\n${stack}` : ''}`),
};
const SERVICE = process.env.SERVICE_NAME ?? 'monsera';

let sentry: any = null;
if (process.env.SENTRY_DSN) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sentry = require('@sentry/node');
    sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.SENTRY_ENVIRONMENT, serverName: SERVICE });
  } catch (error: any) {
    logger.warn(`SENTRY_DSN is set but @sentry/node could not be loaded: ${error.message}`);
  }
}

let eventsQueue: any = null;
async function publishAlert(severity: 'info' | 'warning' | 'critical', title: string, message: string) {
  if (process.env.OPS_ALERTS_ENABLED === 'false' || !process.env.REDIS_URL) return;
  try {
    if (!eventsQueue) {
      const { Queue } = await import('bullmq');
      const { default: connection } = await import('./redis');
      eventsQueue = new Queue('payment-events', { connection, prefix: process.env.BULLMQ_PREFIX || 'bull' });
    }
    // Not awaited by callers: a Redis problem must never delay or fail a request.
    await eventsQueue.add(
      'ops.alert',
      { type: 'ops.alert', data: { severity, title, message }, occurredAt: new Date().toISOString() },
      { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 7 * 24 * 3600 } },
    );
  } catch (error: any) {
    logger.error(`Could not publish ops alert "${title}": ${error.message}`);
  }
}

function titleFor(context: Context | undefined, fallback: string): string {
  const tags = context?.tags ?? {};
  const label = tags.type ?? tags.job ?? tags.cron ?? tags.worker ?? tags.component ?? tags.endpoint;
  return `${SERVICE}: ${label ? String(label) : fallback.slice(0, 80)}`;
}

export function captureException(error: unknown, context?: Context): string {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error(JSON.stringify({ message: err.message, tags: context?.tags, extra: context?.extra }), err.stack);
  sentry?.captureException(err, context);
  void publishAlert('critical', titleFor(context, err.message), `${err.message}\n\nTags: ${JSON.stringify(context?.tags ?? {})}`);
  return '';
}

export function captureMessage(message: string, context?: Context | Level): string {
  const ctx: Context = typeof context === 'string' ? { level: context } : (context ?? {});
  const level = ctx.level ?? 'info';
  const line = JSON.stringify({ message, level, tags: ctx.tags });
  if (level === 'fatal' || level === 'error') logger.error(line);
  else if (level === 'warning') logger.warn(line);
  else logger.log(line);
  sentry?.captureMessage(message, ctx);
  if (level === 'fatal' || level === 'error' || level === 'warning') {
    void publishAlert(level === 'warning' ? 'warning' : 'critical', titleFor(ctx, message), message);
  }
  return '';
}
