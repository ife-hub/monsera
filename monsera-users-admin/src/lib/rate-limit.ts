import { createHash } from 'crypto';
import * as Sentry from './monitoring';
import connection from './redis';

/**
 * Failed-login throttling, stored in Redis so it holds across machines.
 *
 * Fixed window per key: after MAX failures within WINDOW seconds, further
 * attempts are refused until the window expires. Only *failed* attempts
 * count; a successful login clears the per-email counter.
 *
 * Two keys are checked:
 *  - per email (default 5 / 15 min): stops guessing one account's password;
 *  - per client IP (default 20 / 15 min): stops one client spraying many accounts.
 *
 * Emails are hashed before use as keys so Redis (a third-party service)
 * never stores them.
 *
 * Fail-open: if Redis errors or is slow, login is allowed and the failure is
 * reported to Sentry. The shared Redis client retries commands forever
 * (maxRetriesPerRequest: null, needed by BullMQ), so every call here is
 * bounded by a timeout — otherwise a Redis outage would hang every login.
 */

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const LOGIN_LIMITS = {
  maxFailuresPerEmail: () => num(process.env.LOGIN_MAX_FAILURES_PER_EMAIL, 5),
  maxFailuresPerIp: () => num(process.env.LOGIN_MAX_FAILURES_PER_IP, 20),
  windowSeconds: () => num(process.env.LOGIN_FAILURE_WINDOW_SECONDS, 900),
};

const REDIS_TIMEOUT_MS = 500;

function emailKey(email: string) {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `rl:login:email:${digest}`;
}

function ipKey(ip: string) {
  return `rl:login:ip:${ip}`;
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis rate-limit call timed out after ${REDIS_TIMEOUT_MS}ms`)), REDIS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reportAndAllow(error: unknown) {
  Sentry.captureException(error, { tags: { component: 'login-rate-limit' }, level: 'warning' });
}

/**
 * Client IP for rate limiting. On Fly, Fly-Client-IP is set by the edge and
 * cannot be spoofed; X-Forwarded-For is only a fallback (its first entry is
 * client-supplied when not behind a trusted proxy).
 */
export function clientIp(headers: { get(name: string): string | null }): string {
  return (
    headers.get('fly-client-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headers.get('x-real-ip') ??
    'unknown'
  );
}

export interface LoginLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/** Call before checking the password. One Redis round trip. */
export async function checkLoginAllowed(email: string, ip: string): Promise<LoginLimitResult> {
  try {
    const eKey = emailKey(email);
    const iKey = ipKey(ip);
    const results = await withTimeout(
      connection.multi().get(eKey).get(iKey).ttl(eKey).ttl(iKey).exec()
    );
    if (!results) return { allowed: true };

    const [[, eCount], [, iCount], [, eTtl], [, iTtl]] = results as [unknown, any][];
    const emailBlocked = Number(eCount ?? 0) >= LOGIN_LIMITS.maxFailuresPerEmail();
    const ipBlocked = Number(iCount ?? 0) >= LOGIN_LIMITS.maxFailuresPerIp();
    if (!emailBlocked && !ipBlocked) return { allowed: true };

    const ttls = [emailBlocked ? Number(eTtl) : 0, ipBlocked ? Number(iTtl) : 0];
    const retryAfterSeconds = Math.max(1, ...ttls.filter((t) => t > 0));
    return { allowed: false, retryAfterSeconds };
  } catch (error) {
    reportAndAllow(error);
    return { allowed: true };
  }
}

/** Call after a failed attempt (unknown email or wrong password). One round trip. */
export async function recordLoginFailure(email: string, ip: string): Promise<void> {
  const window = LOGIN_LIMITS.windowSeconds();
  try {
    const eKey = emailKey(email);
    const iKey = ipKey(ip);
    // EXPIRE ... NX sets the window only on the first failure, so repeated
    // failures do not keep extending it (fixed window, not sliding).
    await withTimeout(
      connection.multi().incr(eKey).expire(eKey, window, 'NX').incr(iKey).expire(iKey, window, 'NX').exec()
    );
  } catch (error) {
    reportAndAllow(error);
  }
}

/** Call after a successful login so earlier typos don't count against the user. */
export async function clearLoginFailures(email: string): Promise<void> {
  try {
    await withTimeout(connection.del(emailKey(email)));
  } catch (error) {
    reportAndAllow(error);
  }
}
