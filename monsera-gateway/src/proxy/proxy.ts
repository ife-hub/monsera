import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { isPublicPath, serviceFor, serviceUrl, timeoutFor } from './routes';
import { callerKey, checkRateLimit } from './rate-limit';

/**
 * Streams /api requests to the owning service and the answer back,
 * unchanged: status, headers (Retry-After, Content-Type, downloads...) and
 * body. Bodies are never parsed or re-encoded here.
 *
 * The gateway checks the bearer token's signature (cheap rejection of junk);
 * the services check it again against the database (deactivated accounts,
 * password changes) and do all authorisation.
 */

// Headers that describe one hop, not the message (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const MAX_BODY_BYTES = () => Number(process.env.MAX_BODY_BYTES ?? 2 * 1024 * 1024);

function json(res: Response, status: number, body: object, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.status(status).set(headers).json(body);
}

/** Request headers for the upstream call. The client cannot set its own forwarding headers. */
export function upstreamHeaders(req: Request, requestId: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === 'x-forwarded-for' || k === 'x-real-ip' || k === 'forwarded') continue;
    if (value !== undefined) headers[k] = value;
  }
  // req.ip honours `trust proxy` (the platform's load balancer), so this is
  // the real client address; services use it for login throttling.
  headers['x-forwarded-for'] = req.ip ?? '';
  headers['x-real-ip'] = req.ip ?? '';
  headers['x-forwarded-proto'] = req.protocol;
  headers['x-request-id'] = requestId;
  return headers;
}

/** Response headers to pass back. CORS is the gateway's job, so the service's own CORS headers are dropped. */
export function downstreamHeaders(upstream: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstream)) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k.startsWith('access-control-')) continue;
    if (value !== undefined) headers[k] = value;
  }
  return headers;
}

export function createProxy(redis: Redis | null) {
  return async function proxy(req: Request, res: Response, next: NextFunction) {
    if (!req.originalUrl.startsWith('/api/') && req.originalUrl !== '/api') return next();
    if (req.method === 'OPTIONS') return next(); // CORS preflight is answered by the gateway
    if (req.path === '/api/health') return next(); // the gateway's own aggregate health check
    const path = req.originalUrl;
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('x-request-id', requestId);

    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES()) {
      return json(res, 413, { success: false, message: `Request body exceeds ${MAX_BODY_BYTES()} bytes` });
    }

    // Signature check, and who the caller is (for the rate limit).
    let userId: number | undefined;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && !path.startsWith('/api/cron')) {
      try {
        const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET!) as { userId?: number };
        userId = payload.userId;
      } catch {
        return json(res, 401, { success: false, message: 'Invalid or expired token' });
      }
    } else if (!isPublicPath(path)) {
      return json(res, 401, { success: false, message: 'No token provided' });
    }

    const apiKey = (req.headers['api-key'] as string | undefined) || undefined;
    const limit = await checkRateLimit(redis, callerKey(apiKey, userId, req.ip ?? 'unknown'));
    if (!limit.allowed) {
      return json(res, 429, { success: false, message: 'Too many requests. Please slow down.' }, { 'Retry-After': String(limit.retryAfterSeconds) });
    }

    let target: URL;
    try {
      target = new URL(path, serviceUrl(serviceFor(path)));
    } catch (error: any) {
      console.error(`[gateway] ${error.message}`);
      return json(res, 502, { success: false, message: 'Upstream service unavailable' });
    }

    const client = target.protocol === 'https:' ? https : http;
    const upstream = client.request(target, { method: req.method, headers: upstreamHeaders(req, requestId) });
    upstream.setTimeout(timeoutFor(path), () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));

    upstream.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, downstreamHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstream.on('error', (error) => {
      const timedOut = error.message === 'UPSTREAM_TIMEOUT';
      console.error(`[gateway] ${req.method} ${path} -> ${target.host}: ${error.message} (request ${requestId})`);
      if (res.headersSent) return res.destroy();
      json(
        res,
        timedOut ? 504 : 502,
        timedOut
          ? { success: false, message: 'The service did not answer in time. If this was a payment, retry with the same Idempotency-Key: it will not be applied twice.' }
          : { success: false, message: 'Upstream service unavailable' },
      );
    });
    // The client went away: stop the upstream call too (the money endpoints notice and stop early).
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });

    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES()) {
        upstream.destroy();
        json(res, 413, { success: false, message: `Request body exceeds ${MAX_BODY_BYTES()} bytes` });
        req.destroy();
      }
    });
    req.pipe(upstream);
  };
}
