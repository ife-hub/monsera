import type { Redis } from 'ioredis';

/**
 * Per-caller request limit, shared by every gateway instance through Redis.
 *
 * The caller is the partner's API key when one is sent (one partner may use
 * many IPs, and many partners share none), else the signed-in user, else the
 * client IP. A fixed one-minute window per caller; the limit is generous by
 * default (RATE_LIMIT_PER_MINUTE, 1200) because it only exists to stop
 * runaway clients. Fails open: if Redis is slow or down, requests pass.
 */
export const RATE_LIMIT_PER_MINUTE = () => Number(process.env.RATE_LIMIT_PER_MINUTE ?? 1200);
const REDIS_TIMEOUT_MS = 300;

export function callerKey(apiKey: string | undefined, userId: number | undefined, ip: string): string {
  if (apiKey) return `key:${apiKey.slice(0, 64)}`;
  if (userId !== undefined) return `user:${userId}`;
  return `ip:${ip}`;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(redis: Redis | null, caller: string, now = Date.now()): Promise<RateLimitResult> {
  const limit = RATE_LIMIT_PER_MINUTE();
  if (!redis || limit <= 0) return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  const window = Math.floor(now / 60_000);
  const key = `gw:rl:${caller}:${window}`;
  try {
    const count = await Promise.race([
      redis
        .multi()
        .incr(key)
        .expire(key, 120)
        .exec()
        .then((r) => Number(r?.[0]?.[1] ?? 0)),
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('rate limit timeout')), REDIS_TIMEOUT_MS)),
    ]);
    const retryAfterSeconds = Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000));
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
  } catch {
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}
