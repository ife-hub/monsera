import { NextRequest, NextResponse } from '../lib/next-server';
import { verifyToken, JWTPayload } from '../lib/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders } from '../lib/cors';

export interface AuthenticatedRequest extends NextRequest {
  user?: JWTPayload;
}

type RouteContext = { params: Promise<any> } | { params: any };

/**
 * Ensures every response that leaves an authenticated handler carries CORS
 * headers, including success responses that individual handlers forgot to
 * decorate. Headers a handler already set are left untouched.
 */
function ensureCors(response: Response, request: NextRequest): Response {
  if (!response || !(response instanceof Response)) return response;
  if (response.headers.has('Access-Control-Allow-Origin')) return response;
  const headers = getCorsHeaders(request.headers.get('origin'));
  try {
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    return response;
  } catch {
    // Some responses have immutable headers; rebuild with the CORS headers added.
    const merged = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
  }
}

function deny(request: NextRequest, status: number, message: string) {
  return NextResponse.json(
    { success: false, message },
    { status, headers: getCorsHeaders(request.headers.get('origin')) }
  );
}

export function authenticate(handler: Function) {
  return async (request: NextRequest, context?: RouteContext) => {
    const authHeader = request.headers.get('authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return deny(request, 401, 'No token provided');
    }

    let payload: JWTPayload & { iat?: number };
    try {
      payload = verifyToken(authHeader.substring(7));
    } catch {
      return deny(request, 401, 'Invalid or expired token');
    }

    // A token stays cryptographically valid for its full lifetime, so check the
    // account is still active — otherwise deactivated users keep access for 7 days.
    const prisma = (await import('../lib/prisma')).default;
    const account = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { isActive: true, passwordChangedAt: true },
    });
    if (!account || !account.isActive) {
      return deny(request, 401, 'Account is inactive or no longer exists');
    }
    // Tokens issued before the last password change are revoked. `iat` is in
    // whole seconds, so compare at second precision: a token minted in the
    // same second as the change (the one change-password returns) stays valid.
    if (
      account.passwordChangedAt &&
      (payload.iat === undefined || payload.iat < Math.floor(account.passwordChangedAt.getTime() / 1000))
    ) {
      return deny(request, 401, 'Session expired after a password change. Please sign in again.');
    }

    (request as AuthenticatedRequest).user = payload;

    const response = await handler(request, context);
    return ensureCors(response, request);
  };
}

export function authorize(...allowedTypes: UserType[]) {
  return function(handler: Function) {
    return authenticate(async (request: AuthenticatedRequest, context?: RouteContext) => {
      const user = request.user;

      if (!user || !allowedTypes.includes(user.userType)) {
        return deny(request, 403, 'Insufficient permissions');
      }

      return handler(request, context);
    });
  };
}

// Role-based permission checks
export function checkPermission(handler: Function, permission: string) {
  return authenticate(async (request: AuthenticatedRequest, context?: RouteContext) => {
    const user = request.user;

    if (!user) {
      return deny(request, 401, 'Unauthorized');
    }

    // For employees, check role permissions
    if (user.userType === UserType.EMPLOYEE && user.roleId) {
      const prisma = (await import('../lib/prisma')).default;
      const role = await prisma.role.findUnique({
        where: { id: user.roleId }
      });

      if (!role || !(role as any)[permission]) {
        return deny(request, 403, 'Insufficient permissions');
      }
    }

    return handler(request, context);
  });
}
