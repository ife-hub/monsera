jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn() } },
}));

import jwt from 'jsonwebtoken';
import prisma from '@/lib/prisma';
import { authenticate } from '@/middleware/auth';

const mockFindUnique = (prisma as any).user.findUnique as jest.Mock;
const SECRET = 'test-secret';

function requestWith(token?: string): any {
  const headers = new Map<string, string>([['origin', 'https://app.plugmonsera.com']]);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return { headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null } };
}

function tokenIssuedAt(secondsSinceEpoch: number) {
  return jwt.sign({ userId: 1, email: 'a@x.com', userType: 'AGGREGATOR', iat: secondsSinceEpoch }, SECRET);
}

const ok = jest.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
const handler = authenticate(ok);
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = SECRET;
});

describe('authenticate', () => {
  it('rejects requests without a token', async () => {
    expect((await handler(requestWith())).status).toBe(401);
  });

  it('accepts a valid token for an active user with no password change', async () => {
    mockFindUnique.mockResolvedValue({ isActive: true, passwordChangedAt: null });
    const res = await handler(requestWith(tokenIssuedAt(nowSec())));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.plugmonsera.com');
  });

  it('rejects tokens of deactivated users', async () => {
    mockFindUnique.mockResolvedValue({ isActive: false, passwordChangedAt: null });
    expect((await handler(requestWith(tokenIssuedAt(nowSec())))).status).toBe(401);
  });

  it('rejects tokens issued before the last password change', async () => {
    mockFindUnique.mockResolvedValue({ isActive: true, passwordChangedAt: new Date() });
    const res = await handler(requestWith(tokenIssuedAt(nowSec() - 3600)));
    expect(res.status).toBe(401);
    expect((await res.json()).message).toMatch(/password change/);
    expect(ok).not.toHaveBeenCalled();
  });

  it('accepts a token issued in the same second as, or after, the change', async () => {
    const changedAt = new Date();
    mockFindUnique.mockResolvedValue({ isActive: true, passwordChangedAt: changedAt });
    const sameSecond = Math.floor(changedAt.getTime() / 1000);
    expect((await handler(requestWith(tokenIssuedAt(sameSecond)))).status).toBe(200);
    expect((await handler(requestWith(tokenIssuedAt(sameSecond + 5)))).status).toBe(200);
  });

  it('rejects tokens signed with a different secret', async () => {
    const forged = jwt.sign({ userId: 1, email: 'a@x.com', userType: 'MONSERA_ADMIN' }, 'your-secret-key-change-in-production');
    expect((await handler(requestWith(forged))).status).toBe(401);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
