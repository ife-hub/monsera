jest.mock('@sentry/nextjs', () => ({ __esModule: true, captureMessage: jest.fn() }));

import * as Sentry from '@sentry/nextjs';
import { callerGone, isDatabaseOverloaded, overloadedResponse, MONEY_TX_OPTIONS } from '@/lib/db-overload';

describe('isDatabaseOverloaded', () => {
  it.each([
    ['P2024 pool timeout', { code: 'P2024', message: 'Timed out fetching a new connection from the connection pool' }],
    ['P2028 no transaction slot', { code: 'P2028', message: 'Transaction API error: Unable to start a transaction in the given time.' }],
    ['P2028 transaction expired', { code: 'P2028', message: 'Transaction already closed: A query cannot be executed on an expired transaction.' }],
    ['P1001 unreachable', { code: 'P1001', message: "Can't reach database server" }],
    ['P1017 connection closed', { code: 'P1017', message: 'Server has closed the connection.' }],
  ])('treats %s as overload', (_label, error) => {
    expect(isDatabaseOverloaded(error)).toBe(true);
  });

  it.each([
    ['a unique-constraint violation', { code: 'P2002', message: 'Unique constraint failed' }],
    ['another P2028 transaction error', { code: 'P2028', message: 'Transaction API error: something else' }],
    ['a plain bug', new TypeError('x is undefined')],
  ])('does not treat %s as overload', (_label, error) => {
    expect(isDatabaseOverloaded(error)).toBe(false);
  });
});

describe('overloadedResponse', () => {
  it('answers 503 with Retry-After and records a warning, not an exception', async () => {
    const res = overloadedResponse({ 'Access-Control-Allow-Origin': 'x' }, 'debit', { code: 'P2024' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('2');
    expect((await res.json()).message).toMatch(/Idempotency-Key/);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('P2024'), expect.objectContaining({ level: 'warning' }));
  });
});

describe('callerGone', () => {
  it('returns 499 only when the caller has disconnected', () => {
    const controller = new AbortController();
    const request = new Request('http://localhost/x', { signal: controller.signal });
    expect(callerGone(request)).toBeNull();
    controller.abort();
    expect(callerGone(request)?.status).toBe(499);
  });
});

it('waits at most 3s for a transaction slot by default', () => {
  expect(MONEY_TX_OPTIONS.maxWait).toBe(3000);
});
