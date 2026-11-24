jest.mock('@sentry/nextjs', () => ({ __esModule: true, captureException: jest.fn() }));

// Minimal in-memory stand-in for the ioredis MULTI API used by lib/rate-limit.
const store = new Map<string, { value: number; expiresAt?: number }>();
let hang = false;
let fail = false;

function live(key: string) {
  const entry = store.get(key);
  if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

function multi() {
  const ops: Array<() => unknown> = [];
  const chain: any = {
    get: (k: string) => (ops.push(() => (live(k) ? String(live(k)!.value) : null)), chain),
    ttl: (k: string) =>
      (ops.push(() => {
        const e = live(k);
        if (!e) return -2;
        return e.expiresAt === undefined ? -1 : Math.ceil((e.expiresAt - Date.now()) / 1000);
      }), chain),
    incr: (k: string) =>
      (ops.push(() => {
        const e = live(k) ?? { value: 0 };
        e.value += 1;
        store.set(k, e);
        return e.value;
      }), chain),
    expire: (k: string, seconds: number, mode?: string) =>
      (ops.push(() => {
        const e = live(k);
        if (!e || (mode === 'NX' && e.expiresAt !== undefined)) return 0;
        e.expiresAt = Date.now() + seconds * 1000;
        return 1;
      }), chain),
    exec: () => {
      if (hang) return new Promise(() => {});
      if (fail) return Promise.reject(new Error('ERR max daily request limit exceeded'));
      return Promise.resolve(ops.map((op) => [null, op()]));
    },
  };
  return chain;
}

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: {
    multi: () => multi(),
    del: (k: string) => (hang ? new Promise(() => {}) : Promise.resolve(store.delete(k) ? 1 : 0)),
  },
}));

import * as Sentry from '@sentry/nextjs';
import { checkLoginAllowed, recordLoginFailure, clearLoginFailures, clientIp } from '@/lib/rate-limit';

beforeEach(() => {
  store.clear();
  hang = false;
  fail = false;
  jest.clearAllMocks();
  delete process.env.LOGIN_MAX_FAILURES_PER_EMAIL;
  delete process.env.LOGIN_MAX_FAILURES_PER_IP;
});

async function fail_n(n: number, email = 'a@x.com', ip = '1.1.1.1') {
  for (let i = 0; i < n; i++) await recordLoginFailure(email, ip);
}

describe('login rate limit', () => {
  it('allows attempts below the per-email limit', async () => {
    await fail_n(4);
    expect(await checkLoginAllowed('a@x.com', '1.1.1.1')).toEqual({ allowed: true });
  });

  it('blocks the email after 5 failures and reports a Retry-After within the window', async () => {
    await fail_n(5);
    const result = await checkLoginAllowed('a@x.com', '9.9.9.9');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it('treats email case and surrounding spaces as the same account', async () => {
    await fail_n(5, 'A@X.com');
    expect((await checkLoginAllowed('  a@x.COM ', '9.9.9.9')).allowed).toBe(false);
  });

  it('blocks an IP spraying many accounts after 20 failures', async () => {
    for (let i = 0; i < 20; i++) await recordLoginFailure(`user${i}@x.com`, '6.6.6.6');
    expect((await checkLoginAllowed('fresh@x.com', '6.6.6.6')).allowed).toBe(false);
    expect((await checkLoginAllowed('fresh@x.com', '7.7.7.7')).allowed).toBe(true);
  });

  it('does not extend the window on repeated failures (fixed window)', async () => {
    await recordLoginFailure('a@x.com', '1.1.1.1');
    const firstExpiry = [...store.values()][0].expiresAt;
    await recordLoginFailure('a@x.com', '1.1.1.1');
    expect([...store.values()][0].expiresAt).toBe(firstExpiry);
  });

  it('clears the per-email counter after a successful login', async () => {
    await fail_n(4);
    await clearLoginFailures('a@x.com');
    await fail_n(1);
    expect((await checkLoginAllowed('a@x.com', '1.1.1.1')).allowed).toBe(true);
  });

  it('respects limits configured through env', async () => {
    process.env.LOGIN_MAX_FAILURES_PER_EMAIL = '2';
    await fail_n(2);
    expect((await checkLoginAllowed('a@x.com', '1.1.1.1')).allowed).toBe(false);
  });

  it('never stores the raw email in Redis keys', async () => {
    await fail_n(1, 'secret@x.com');
    expect([...store.keys()].some((k) => k.includes('secret'))).toBe(false);
  });

  it('fails open and reports to Sentry when Redis errors (e.g. Upstash quota)', async () => {
    fail = true;
    expect(await checkLoginAllowed('a@x.com', '1.1.1.1')).toEqual({ allowed: true });
    await expect(recordLoginFailure('a@x.com', '1.1.1.1')).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('fails open within the timeout when Redis hangs instead of blocking login', async () => {
    hang = true;
    const started = Date.now();
    expect(await checkLoginAllowed('a@x.com', '1.1.1.1')).toEqual({ allowed: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('clientIp', () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

  it('prefers the Fly edge header over X-Forwarded-For', () => {
    expect(clientIp(headers({ 'fly-client-ip': '1.2.3.4', 'x-forwarded-for': '6.6.6.6' }))).toBe('1.2.3.4');
  });
  it('falls back to the first X-Forwarded-For entry', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '5.5.5.5, 10.0.0.1' }))).toBe('5.5.5.5');
  });
  it('returns "unknown" when no header is present', () => {
    expect(clientIp(headers({}))).toBe('unknown');
  });
});
