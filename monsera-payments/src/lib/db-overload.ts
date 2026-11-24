import { NextResponse } from './next-server';
import * as Sentry from './monitoring';

/**
 * Load shedding for the money endpoints.
 *
 * The app has a small database connection pool. When every connection is
 * busy (a traffic spike, or a slow database), requests used to queue for up
 * to 10s for a transaction slot and 30s for a query slot, then fail with a
 * 500 — while the backlog kept growing and the app went on working through
 * requests whose callers had long given up. Instead:
 *
 *  - wait only briefly for a connection (DB_TX_MAX_WAIT_MS, default 3s;
 *    the query pool_timeout in lib/prisma.ts defaults to 10s);
 *  - answer "database busy/unreachable" with 503 + Retry-After, so partners
 *    retry with the same Idempotency-Key (nothing was written: a transaction
 *    that never started, or timed out, rolled back);
 *  - stop before expensive work when the caller has already disconnected.
 */

/** Interactive-transaction limits for disbursement and recovery. */
export const MONEY_TX_OPTIONS = {
  maxWait: Number(process.env.DB_TX_MAX_WAIT_MS) || 3000,
  timeout: Number(process.env.DB_TX_TIMEOUT_MS) || 30000,
};

/**
 * True when an error means "the database is saturated or unreachable",
 * rather than a bug: pool timeout (P2024), no transaction slot / expired
 * transaction (P2028), or the server not reachable / timing out / closing
 * the connection (P1001, P1002, P1017).
 */
export function isDatabaseOverloaded(error: unknown): boolean {
  const code = (error as any)?.code;
  if (code === 'P2024' || code === 'P1001' || code === 'P1002' || code === 'P1017') return true;
  if (code === 'P2028') {
    const message = String((error as any)?.message ?? '');
    return /unable to start a transaction|expired transaction|transaction already closed/i.test(message);
  }
  return false;
}

export function overloadedResponse(headers: Record<string, string>, endpoint: string, error: unknown) {
  // A warning, not an exception: under overload this fires per request.
  Sentry.captureMessage(`Database overloaded on ${endpoint}: ${(error as any)?.code ?? 'unknown'}`, {
    level: 'warning',
    tags: { type: 'database_overloaded', endpoint },
  });
  return NextResponse.json(
    { success: false, message: 'Service is temporarily busy. Please retry shortly with the same Idempotency-Key.' },
    { status: 503, headers: { ...headers, 'Retry-After': '2' } }
  );
}

/**
 * The caller disconnected (e.g. its HTTP client timed out). Returned instead
 * of doing work nobody will receive. 499 = "client closed request".
 */
export function callerGone(request: Request): NextResponse | null {
  if (!request.signal?.aborted) return null;
  return NextResponse.json({ success: false, message: 'Client closed the request' }, { status: 499 });
}
