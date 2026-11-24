import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createProxy } from '../src/proxy/proxy';
import { serviceFor, isPublicPath } from '../src/proxy/routes';
import { callerKey } from '../src/proxy/rate-limit';

const SECRET = 'test-secret';
const token = jwt.sign({ userId: 7, userType: 'AGGREGATOR', email: 'a@b.c' }, SECRET);

let upstream: http.Server;
let seen: { method?: string; url?: string; headers?: http.IncomingHttpHeaders; body?: string };
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      respond(req, res);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  Object.assign(process.env, { JWT_SECRET: SECRET, PAYMENTS_URL: url, VEND_INGESTION_URL: url, USERS_ADMIN_URL: url, ADMIN_URL: url });
});
afterAll(() => new Promise((r) => upstream.close(r)));

function app(redis: any = null) {
  const a = express();
  a.set('trust proxy', 1);
  a.use(createProxy(redis));
  return a;
}

beforeEach(() => {
  seen = {};
  respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
});

describe('routing table', () => {
  it.each([
    ['/api/transactions/debit', 'payments'],
    ['/api/wallet/add/3', 'payments'],
    ['/api/obligations/suspensions', 'payments'],
    ['/api/partners/vends/batch', 'vend-ingestion'],
    ['/api/auth/login', 'users-admin'],
    ['/api/users/4', 'users-admin'],
    ['/api/aggregators?page=2', 'admin'],
    ['/api/float-ledger/9', 'admin'],
    ['/api/transactionsX', 'admin'],
  ])('%s -> %s', (path, service) => expect(serviceFor(path)).toBe(service));

  it('only login and the cron endpoints are reachable without a token', () => {
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/cron/sweep')).toBe(true);
    expect(isPublicPath('/api/auth/me')).toBe(false);
  });
});

describe('proxy', () => {
  it('streams the request through unchanged and returns the response with its headers', async () => {
    respond = (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/csv', 'retry-after': '2', 'content-disposition': 'attachment; filename="x.csv"', 'access-control-allow-origin': '*' });
      res.end('a,b\n1,2\n');
    };
    const body = JSON.stringify({ meterToken: 'MT-1', amount: 4000 });
    const res = await request(app())
      .post('/api/transactions/debit?x=1')
      .set('Authorization', `Bearer ${token}`)
      .set('API-Key', 'k')
      .set('Idempotency-Key', 'idem-1')
      .set('Content-Type', 'application/json')
      // The client sent a spoofed 6.6.6.6; the load balancer appended the real address.
      .set('X-Forwarded-For', '6.6.6.6, 203.0.113.9')
      .send(body);

    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/api/transactions/debit?x=1');
    expect(seen.body).toBe(body);
    expect(seen.headers!['idempotency-key']).toBe('idem-1');
    expect(seen.headers!['api-key']).toBe('k');
    // The client cannot choose the address the services throttle on.
    expect(seen.headers!['x-forwarded-for']).toBe('203.0.113.9');
    expect(seen.headers!['x-request-id']).toBeTruthy();

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.headers['content-disposition']).toContain('x.csv');
    expect(res.headers['access-control-allow-origin']).toBeUndefined(); // the gateway owns CORS
    expect(res.text).toBe('a,b\n1,2\n');
  });

  it('refuses a protected path without a token, and a bad token, before calling the service', async () => {
    expect((await request(app()).get('/api/transactions')).status).toBe(401);
    expect((await request(app()).get('/api/transactions').set('Authorization', 'Bearer nope')).status).toBe(401);
    expect(seen.url).toBeUndefined();
  });

  it('lets login through without a token', async () => {
    const res = await request(app()).post('/api/auth/login').send({ email: 'a', password: 'b' });
    expect(res.status).toBe(200);
    expect(seen.url).toBe('/api/auth/login');
  });

  it('rejects an oversized body with 413', async () => {
    process.env.MAX_BODY_BYTES = '100';
    const res = await request(app()).post('/api/partners/vends/batch').set('Authorization', `Bearer ${token}`).send('x'.repeat(500));
    delete process.env.MAX_BODY_BYTES;
    expect(res.status).toBe(413);
  });

  it('answers 504 with retry guidance when the service does not answer in time', async () => {
    process.env.UPSTREAM_TIMEOUT_MS = '100';
    respond = () => undefined; // never answers
    const res = await request(app()).get('/api/aggregators').set('Authorization', `Bearer ${token}`);
    delete process.env.UPSTREAM_TIMEOUT_MS;
    expect(res.status).toBe(504);
    expect(res.body.message).toContain('Idempotency-Key');
  });

  it('answers 429 with Retry-After once a caller is over the limit', async () => {
    let count = 0;
    const redis = { multi: () => ({ incr() { return this; }, expire() { return this; }, exec: async () => [[null, ++count]] }) };
    process.env.RATE_LIMIT_PER_MINUTE = '2';
    const a = app(redis);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await request(a).get('/api/wallet/1').set('Authorization', `Bearer ${token}`).set('API-Key', 'k')).status);
    delete process.env.RATE_LIMIT_PER_MINUTE;
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('fails open when Redis does not answer', async () => {
    const redis = { multi: () => ({ incr() { return this; }, expire() { return this; }, exec: () => new Promise(() => undefined) }) };
    const res = await request(app(redis)).get('/api/wallet/1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('callerKey', () => {
  it('prefers the API key, then the user, then the IP', () => {
    expect(callerKey('abc', 1, '1.1.1.1')).toBe('key:abc');
    expect(callerKey(undefined, 1, '1.1.1.1')).toBe('user:1');
    expect(callerKey(undefined, undefined, '1.1.1.1')).toBe('ip:1.1.1.1');
  });
});
