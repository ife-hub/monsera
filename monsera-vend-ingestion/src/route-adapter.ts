/**
 * Mounts Fetch-style route handlers (export async function GET/POST/... taking
 * a Request and returning a Response) on the Express app under Nest.
 *
 * The handlers are the ones from monsera-backend's app/api, kept unchanged so
 * behaviour (and the tests that cover it) carries over exactly. Nest still
 * owns bootstrapping, health, workers and scheduling.
 */
import type { Express, NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { Logger } from '@nestjs/common';
import { NextRequest } from './lib/next-server';

export interface RouteEntry {
  /** Express path, e.g. /api/wallet/:id */
  path: string;
  module: Record<string, unknown>;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 2 * 1024 * 1024);
const logger = new Logger('Routes');

class PayloadTooLargeError extends Error {}

async function readBody(req: ExpressRequest): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function toFetchRequest(req: ExpressRequest, res: ExpressResponse): Promise<NextRequest> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  // Lets handlers notice a caller that has gone away (lib/db-overload callerGone).
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  const body = await readBody(req);
  const url = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;
  return new NextRequest(url, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined, signal: controller.signal });
}

async function sendFetchResponse(res: ExpressResponse, response: Response) {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'content-length') res.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

export function mountRoutes(app: Express, routes: RouteEntry[]) {
  for (const { path, module } of routes) {
    for (const method of METHODS) {
      const handler = module[method];
      if (typeof handler !== 'function') continue;
      (app as any)[method.toLowerCase()](path, async (req: ExpressRequest, res: ExpressResponse, _next: NextFunction) => {
        try {
          const request = await toFetchRequest(req, res);
          const response: Response = await handler(request, { params: Promise.resolve({ ...req.params }) });
          await sendFetchResponse(res, response);
        } catch (error: any) {
          if (error instanceof PayloadTooLargeError) {
            res.status(413).json({ success: false, message: `Request body exceeds ${MAX_BODY_BYTES} bytes` });
            return;
          }
          logger.error(`${req.method} ${req.originalUrl} failed: ${error?.message}`, error?.stack);
          if (!res.headersSent) res.status(500).json({ success: false, message: 'Internal server error' });
        }
      });
    }
  }
}
