import { NextResponse } from './next-server';

/**
 * Central CORS configuration.
 * Add new allowed origins here — do not hardcode origins in individual route files.
 */
const ALLOWED_ORIGINS = [
  'https://monsera-frontend-pwjpq.ondigitalocean.app',
  'https://app.plugmonsera.com',
  'http://localhost:3000'
  // Add new origins below this line
];

/**
 * Returns CORS headers for a given request origin.
 * If the request origin is in the allowed list it is reflected back.
 * If not, the first allowed origin is used as the default.
 * 
 * Use this in handlers that receive requests with credentials
 * (Access-Control-Allow-Credentials: true requires an exact origin, not a wildcard).
 */
export function getCorsHeaders(requestOrigin?: string | null): Record<string, string> {
  const origin = ALLOWED_ORIGINS.includes(requestOrigin ?? '')
    ? requestOrigin!
    : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, API-Key, Idempotency-Key',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * Static CORS headers using the first allowed origin.
 * Used in route files that hardcode corsHeaders at the top.
 * For per-request origin matching use corsHeaders).
 */
export const corsHeaders = getCorsHeaders();

/**
 * Applies CORS headers to an existing NextResponse.
 * Pass the request origin for accurate origin reflection.
 */
export function withCors(response: NextResponse, requestOrigin?: string | null): NextResponse {
  const headers = getCorsHeaders(requestOrigin);
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

/**
 * Standard OPTIONS preflight response.
 * Call this from every OPTIONS export in your route files.
 */
export function handleOptions(request: Request): NextResponse {
  const origin = request.headers.get('origin');
  return new NextResponse(null, {
    status: 200,
    headers: getCorsHeaders(origin),
  });
}