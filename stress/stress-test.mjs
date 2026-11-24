#!/usr/bin/env node
/**
 * Monsera stress test — plain Node, no k6.
 *
 *   cd stress && npm ci && node stress-test.mjs
 *
 * Runs against YOUR running app and the database in your .env. Existing data
 * is kept: the script only ADDS stress accounts, stress meters, a float
 * top-up to Wallet A and the loans/repayments the load creates.
 *
 * Before you run it:
 *   1. .env points DATABASE_URL at your TEST database (never production).
 *   2. The app is running against that same .env, ideally a production build:
 *        docker compose up --build        (from the repo root)
 *      (each service's `npm run start:dev` works too, but timings are
 *      not representative.)
 *   3. The app's SCORING_ENGINE_URL must answer. With no real engine, run
 *      the bundled mock in another terminal and point the app at it:
 *        node stress/mock-scoring-engine.js        (listens on :4001)
 *        SCORING_ENGINE_URL=http://localhost:4001 in .env, then restart the app
 *
 * What it does (mirrors monsera-realistic-stress-test.js + eligibility-p95.js):
 *   setup     stress aggregator/disco (created once, reused), cohort meters,
 *             Wallet A top-up (as ledger entries), debts for the race test
 *   history   every meter the run will advance gets a realistic vend history
 *             (about 15 vends over 55 days, uploaded as the stress disco);
 *             waits for the vend-metrics worker to build its features, because
 *             the scoring engine refuses meters with no history
 *   baseline  ledger invariants + controlling identity, measured BEFORE
 *   load      1 batch debits        3/s for 3 min
 *             2 batch repayments    2/s for 2.5 min (starts at 30s)
 *             3 dashboard reads     5/s for 3 min
 *             4 end-of-day spike    ramps 0→8→15→8→0/s (starts at 1m30s)
 *             5 retried debits      same Idempotency-Key twice, 25 times
 *             6 retried repayments  same Idempotency-Key twice, 25 times
 *             7 repayment race      two simultaneous repayments, 10 meters
 *             8 advance race        two simultaneous advances, 10 new meters
 *   p95       §9.2: 50 concurrent advance requests for 60s, p95 < 800ms
 *   vends     (only with VENDS=1 or ONLY=vends) disco vend uploads:
 *             20 batches × 100 vends with ~3% invalid rows and ~2% in-batch
 *             duplicates; every 5th batch sent twice at once (partner retry);
 *             resends unchanged and with corrected amounts; single vends.
 *             Checks: right accept/reject per row, each vend stored once,
 *             one revision per correction, every rejection logged, and the
 *             vend-metrics worker processes everything and catches up
 *   verify    every invariant and the identity must be UNCHANGED by the run
 *             (your older data may already fail some; that is reported, not
 *             failed), plus the financial checks above must be zero
 *
 * Options (environment variables):
 *   BASE_URL        app URL                         (default http://localhost:3000)
 *   ONLY            realistic | p95 | vends         (default: realistic + p95)
 *   VENDS           1 = also run the vend scenario after the others
 *   VEND_BATCHES    number of vend batches          (default 20)
 *   VEND_BATCH_SIZE vends per batch, max 500        (default 100)
 *   VEND_CONCURRENCY  batches in flight at once     (default 4)
 *   VEND_METERS     distinct meters the vends use   (default 50)
 *   METRICS_WAIT_SECONDS  how long to wait for the worker  (default 90)
 *   SCALE           multiply scenario durations     (default 1; 0.2 = quick run)
 *   RATE            multiply request rates          (default 1; 0.2 = a fifth of the load)
 *   P95_SECONDS     length of the p95 test          (default 60)
 *   CONCURRENCY     p95 concurrency                 (default 50)
 *   P95_METERS      fresh meters for the p95 phase  (default 3000; each one
 *                   is used once, and each gets a vend history first)
 *   VEND_HISTORY    vends per meter in its history  (default 15, ±3)
 *   HISTORY_WAIT_SECONDS  how long to wait for features to be built (default 600)
 *   TOPUP_NAIRA     float added to Wallet A         (default 200000000; 0 = none)
 *   PROGRESS_SECONDS  status line interval          (default 5)
 *   ALLOW_DECLINES  1 = run even if the pre-flight advance is declined
 *
 * While it runs, a status line every 5s shows the stage, elapsed time,
 * requests sent, approvals/declines, server errors and recent p95. It is
 * finished when it prints "ALL PASSED" or "FAILED" and the prompt returns.
 *
 * Redis: the APP talks to Redis (this script does not). If the app uses a
 * shared Redis (e.g. the live one), start it with BULLMQ_PREFIX=stress so its
 * queue jobs are kept apart from the live app's. The vend scenario needs the
 * queue WORKERS in monsera-vend-ingestion (not started when RUN_WORKERS=false).
 *
 * Exit code 0 = everything passed, 1 = a check failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Settings come from .env on a laptop. On a server (e.g. the app's own
// container) they are already environment variables and there is no .env,
// so dotenv is optional.
// stress/.env (copy stress/.env.example). Values already in the environment win.
const envFile = path.join(HERE, '.env');
if (fs.existsSync(envFile)) {
  const dotenv = await import('dotenv').catch(() => null);
  if (dotenv) dotenv.default.config({ path: envFile, quiet: true });
  else console.warn('note: .env found but the dotenv package is not installed; using environment variables only');
}

// ── Config ─────────────────────────────────────────────────────────────────
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ONLY = process.env.ONLY || '';
const SCALE = Number(process.env.SCALE || 1);
const RATE = Number(process.env.RATE || 1); // multiplies the request rates of scenarios 1–4
const P95_SECONDS = Number(process.env.P95_SECONDS || 60);
const CONCURRENCY = Number(process.env.CONCURRENCY || 50);
const P95_METERS = Number(process.env.P95_METERS || 3000); // fresh meters (with vend history) for the p95 phase
const TOPUP_NAIRA = Number(process.env.TOPUP_NAIRA ?? 200_000_000);
const WALLET = {
  A: Number(process.env.WALLET_A_ID) || 1,
  B: Number(process.env.WALLET_B_ID) || 2,
  C: Number(process.env.WALLET_C_ID) || 3,
};
const TIERS = [2000, 4000, 7000]; // pilot obligation tiers, naira
const RETRY_ITERATIONS = 25;
const RACE_ITERATIONS = 10;
const RUN_ID = Date.now().toString(36);
const STRESS = {
  aggregator: { email: 'stress-aggregator@example.test', name: 'Stress Aggregator (k6)', apiKey: 'stress-aggregator-key' },
  disco: { email: 'stress-disco@example.test', name: 'Stress Disco (k6)', apiKey: 'stress-disco-key' },
};
const METER_POOL = Array.from({ length: 25 }, (_, i) => `STRESS-METER-${String(i).padStart(4, '0')}`);
const meterName = (kind, n) => `STRESS-${kind}-${RUN_ID}-${n}`;

if (!process.env.DATABASE_URL) fail('No DATABASE_URL in .env');
if (!process.env.JWT_SECRET) fail('No JWT_SECRET in .env (it must be the one the running app uses)');

const prisma = new PrismaClient();

// ── Small helpers ──────────────────────────────────────────────────────────
function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (list) => list[randInt(0, list.length - 1)];
const num = (v) => Number(v ?? 0);
const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

// Metrics: durations per kind, failed checks, financial-correctness counters.
const durations = {};
const checks = {}; // name -> { pass, fail }
const counters = {
  server_errors: 0,
  duplicate_debits_created: 0,
  duplicate_credits_created: 0,
  idempotency_replay_missing: 0,
  double_applied_repayments: 0,
  concurrent_advances_approved: 0,
};
function record(kind, ms) {
  (durations[kind] ||= []).push(ms);
}

// ── Progress: one status line every PROGRESS_SECONDS while load runs ──────
const PROGRESS_SECONDS = Number(process.env.PROGRESS_SECONDS || 5);
const progress = { phase: 'setup', phaseStart: performance.now(), requests: 0, lastRequests: 0, approved: 0, declined: 0, recent: [] };
const declineReasons = {}; // reason -> count
const topReason = () => Object.entries(declineReasons).sort((a, b) => b[1] - a[1])[0];
function startPhase(name) {
  progress.phase = name;
  progress.phaseStart = performance.now();
}
const mmss = (ms) => {
  const t = Math.floor(ms / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
function printProgress() {
  const perSecond = (progress.requests - progress.lastRequests) / PROGRESS_SECONDS;
  progress.lastRequests = progress.requests;
  const p95 = percentile(progress.recent, 95);
  progress.recent = [];
  console.log(
    `  [${progress.phase} ${mmss(performance.now() - progress.phaseStart)}] ` +
      `${progress.requests} requests (${perSecond.toFixed(1)}/s), ${inflight.size} in flight | ` +
      `advances: ${progress.approved} approved, ${progress.declined} declined | ` +
      `5xx/timeouts: ${counters.server_errors} | p95 last ${PROGRESS_SECONDS}s: ${p95 ? p95.toFixed(0) + 'ms' : '-'}` +
      (topReason() ? ` | top decline: "${topReason()[0].slice(0, 60)}" (${topReason()[1]})` : '')+
      (networkRetries.count ? ` | network retries: ${networkRetries.count} (${networkRetries.lastCode})` : '')
  );
  if (inflight.size > 200 && !progress.warnedBacklog) {
    progress.warnedBacklog = true;
    console.log(`  ! ${inflight.size} requests waiting: the app cannot keep up with this load. Results from here on`);
    console.log('    measure queueing, not the app. Re-run with a lower RATE (e.g. RATE=0.3), or run the app nearer its database.');
  }
}
function check(name, ok) {
  const c = (checks[name] ||= { pass: 0, fail: 0 });
  ok ? c.pass++ : c.fail++;
  return ok;
}

let HEADERS;
// Failures that happen before the request leaves this machine (DNS lookup,
// connection refused). Nothing reached the app, so a retry is always safe.
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);
const networkRetries = { count: 0, lastCode: null };

async function http(method, urlPath, body, extraHeaders = {}, kind = null) {
  let started = performance.now();
  let status = 0;
  let json = null;
  let headers = new Headers();
  for (let attempt = 1; ; attempt++) {
    started = performance.now(); // time only the attempt that reached the app
    try {
      const res = await fetch(`${BASE_URL}${urlPath}`, {
        method,
        headers: { ...HEADERS, ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(65_000),
      });
      status = res.status;
      headers = res.headers;
      json = await res.json().catch(() => null);
      break;
    } catch (error) {
      status = 0;
      // fetch() reports every network failure as "fetch failed"; the cause
      // says which (ENOTFOUND = DNS lookup failed, ECONNREFUSED = app not
      // running, ECONNRESET = app dropped the connection, TimeoutError = no
      // answer within 65s, …).
      const cause = error?.cause?.code ?? error?.cause?.message ?? error?.name;
      json = { error: `${error?.message ?? error}${cause ? ` (${cause})` : ''}` };
      if (!NOT_SENT.has(cause) || attempt >= 5) break;
      networkRetries.count++;
      networkRetries.lastCode = cause;
      await sleep(500 * 2 ** (attempt - 1)); // 0.5s, 1s, 2s, 4s
    }
  }
  const ms = performance.now() - started;
  if (kind) record(kind, ms);
  progress.requests++;
  progress.recent.push(ms);
  if (urlPath === '/api/transactions/debit') {
    if (status === 201) progress.approved++;
    else if (status === 200) {
      progress.declined++;
      const reason = String(json?.reason ?? 'unknown');
      declineReasons[reason] = (declineReasons[reason] || 0) + 1;
    }
  }
  if (status >= 500 || status === 0) counters.server_errors++;
  return { status, json, headers, ms };
}
const debit = (meterToken, amount, kind = 'debit', key = randomUUID()) =>
  http('POST', '/api/transactions/debit', { meterToken, amount, disco: STRESS.discoName }, { 'Idempotency-Key': key }, kind);
const credit = (meterToken, amountKobo, kind = 'credit', key = randomUUID()) =>
  http('POST', '/api/transactions/credit', { meterToken, amountKobo, disco: STRESS.discoName }, { 'Idempotency-Key': key }, kind);

// ── Setup: only adds data ──────────────────────────────────────────────────
async function ensureUser(email, name, userType) {
  return prisma.user.upsert({
    where: { email },
    update: { isActive: true },
    create: { email, name, userType, passwordHash: 'not-a-real-hash', isActive: true },
  });
}

async function setup(p95Meters, { topup = true } = {}) {
  const aggUser = await ensureUser(STRESS.aggregator.email, STRESS.aggregator.name, 'AGGREGATOR');
  const discoUser = await ensureUser(STRESS.disco.email, STRESS.disco.name, 'DISCO_ADMIN');

  // Partner rows attached to the stress logins: created once, then reused.
  const aggregator =
    (await prisma.aggregator.findUnique({ where: { userId: aggUser.id } })) ??
    (await prisma.aggregator.create({
      data: { userId: aggUser.id, name: STRESS.aggregator.name, mail: aggUser.email, status: 'active', outstanding: 0, balance: 0, lastInteraction: new Date() },
    }));
  await prisma.aggregator.update({ where: { id: aggregator.id }, data: { apiKey: STRESS.aggregator.apiKey, status: 'active' } });

  const disco =
    (await prisma.discoAdmin.findUnique({ where: { userId: discoUser.id } })) ??
    (await prisma.discoAdmin.create({
      data: { userId: discoUser.id, name: STRESS.disco.name, mail: discoUser.email, status: 'active', balance: 0, outstanding: 0, lastInteraction: new Date() },
    }));
  await prisma.discoAdmin.update({ where: { id: disco.id }, data: { apiKey: STRESS.disco.apiKey, status: 'active' } });
  STRESS.discoName = disco.name;
  STRESS.discoId = disco.id;

  // Wallets the app uses — created only if missing.
  for (const [type, id] of Object.entries(WALLET)) {
    await prisma.$executeRaw`INSERT INTO "Wallet" (id, "walletType", balance) VALUES (${id}, ${type}::"WalletType", 0) ON CONFLICT (id) DO NOTHING`;
  }
  await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"Wallet"', 'id'), GREATEST((SELECT MAX(id) FROM "Wallet"), 1))`);

  // Float top-up, appended as ledger rows (amountKobo is 32-bit: ≤ ₦20M per
  // row) with the balance moved by the same amount, under the wallet lock.
  const topupKobo = topup ? Math.round(TOPUP_NAIRA * 100) : 0;
  if (topupKobo > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${WALLET.A} FOR UPDATE`;
      for (let left = topupKobo; left > 0; left -= 2_000_000_000) {
        await tx.walletTransaction.create({
          data: { walletId: WALLET.A, type: 'top-up', amountKobo: Math.min(left, 2_000_000_000), referenceId: `stress-${RUN_ID}`, description: `Stress test float top-up (${RUN_ID})` },
        });
      }
      await tx.$executeRaw`UPDATE "Wallet" SET balance = COALESCE(balance, 0) + ${topupKobo}::numeric / 100, "updatedAt" = now() WHERE id = ${WALLET.A}`;
    });
  }

  // Cohort: the shared pool plus this run's own meters.
  const runMeters = [];
  for (let i = 0; i < RETRY_ITERATIONS; i++) runMeters.push(meterName('RETRY-D', i), meterName('RETRY-C', i));
  for (let i = 0; i < RACE_ITERATIONS; i++) runMeters.push(meterName('RACE-C', i), meterName('RACE-D', i));
  runMeters.push(meterName('PREFLIGHT', 0));
  const allMeters = [...METER_POOL, ...runMeters, ...p95Meters];
  for (let i = 0; i < allMeters.length; i += 5000) {
    await prisma.cohortMeter.createMany({ data: allMeters.slice(i, i + 5000).map((meterToken) => ({ meterToken, source: `stress-${RUN_ID}` })), skipDuplicates: true });
  }
  await prisma.cohortMeter.updateMany({ where: { meterToken: { in: METER_POOL }, removedAt: { not: null } }, data: { removedAt: null } });
  await prisma.customer.createMany({
    data: METER_POOL.map((meterToken) => ({ meterToken, band: 'B', riskLevel: 'low', outstanding: 0, status: 'active', state: 'active', lastInteraction: new Date(), dateAdded: new Date() })),
    skipDuplicates: true,
  });

  return { aggUser, discoUser, disco };
}

// ── Ledger checks (read-only) ──────────────────────────────────────────────
const INVARIANTS_SQL = fs.readFileSync(path.join(HERE, 'verify-invariants.sql'), 'utf8');
async function invariants() {
  const rows = await prisma.$queryRawUnsafe(INVARIANTS_SQL);
  return Object.fromEntries(rows.map((r) => [r.check_name, num(r.violations)]));
}

/** Controlling identity, signed: (A + B + outstanding) − (float deployed + commission not yet paid out). */
async function identityKobo() {
  const [row] = await prisma.$queryRaw`
    SELECT
      (SELECT COALESCE(ROUND(SUM(balance) * 100), 0) FROM "Wallet" WHERE id IN (${WALLET.A}, ${WALLET.B})) AS wallets,
      (SELECT COALESCE(SUM("remainingKobo"), 0) FROM "Obligation") AS outstanding,
      (SELECT COALESCE(SUM("amountKobo"), 0) FROM "WalletTransaction"
        WHERE "walletId" IN (${WALLET.A}, ${WALLET.B}) AND type IN ('top-up', 'allocation', 'withdrawal', 'opening-balance')) AS deployed,
      (SELECT COALESCE(SUM("serviceKobo"), 0) FROM "Obligation") AS accrued,
      (SELECT COALESCE(SUM("amountKobo"), 0) FROM "WalletTransaction" WHERE "walletId" = ${WALLET.B} AND type = 'commission-payout') AS payouts`;
  return num(row.wallets) + num(row.outstanding) - (num(row.deployed) + num(row.accrued) + num(row.payouts));
}

// ── Load shapes ────────────────────────────────────────────────────────────
const inflight = new Set();
function launch(promise) {
  inflight.add(promise);
  promise.finally(() => inflight.delete(promise));
}
/** Starts fn `ratePerSecond(t)` times a second from startS for durationS (scaled). */
async function arrivalRate(fn, ratePerSecond, startS, durationS) {
  await sleep(startS * SCALE * 1000);
  const end = performance.now() + durationS * SCALE * 1000;
  const t0 = performance.now();
  let owed = 0;
  while (performance.now() < end) {
    const t = (performance.now() - t0) / 1000 / SCALE; // unscaled seconds into the scenario
    owed += (ratePerSecond(t) * RATE) / 10;
    while (owed >= 1) {
      launch(fn());
      owed--;
    }
    await sleep(100);
  }
}
const constant = (rate) => () => rate;
function ramp(stages) {
  return (t) => {
    let start = 0;
    let from = 0;
    for (const s of stages) {
      if (t < start + s.duration) return from + ((s.target - from) * (t - start)) / s.duration;
      start += s.duration;
      from = s.target;
    }
    return 0;
  };
}

// ── Flows ──────────────────────────────────────────────────────────────────
async function debitFlow() {
  const r = await debit(pick(METER_POOL), pick(TIERS));
  check('debit: 201 approved or 200 declined', r.status === 201 || r.status === 200);
}

async function creditFlow() {
  const r = await credit(pick(METER_POOL), randInt(50_000, 700_000));
  check('credit: 201, or 404 when nothing is owed', r.status === 201 || r.status === 404);
}

async function readFlow() {
  const list = await http('GET', '/api/transactions?page=1&limit=50', null, {}, 'list');
  check('list: 200', list.status === 200);
  const rows = list.json?.data ?? [];
  if (rows.length > 0) {
    const detail = await http('GET', `/api/transactions/${pick(rows.slice(0, 10)).id}`, null, {}, 'detail');
    check('detail: 200', detail.status === 200);
  }
}

const debitId = (r) => r.json?.data?.transaction?.transactionId ?? r.json?.data?.transactionId ?? null;
const creditId = (r) => r.json?.data?.repaymentTransaction?.transactionId ?? r.json?.data?.repaymentTransactionId ?? null;
function checkReplay(kind, first, second, idOf) {
  if (first.status !== 201) return; // only successful writes are cached
  const replayed = second.headers.get('x-idempotent-replay') === 'true';
  if (!check(`${kind} retry served as a replay`, replayed)) counters.idempotency_replay_missing++;
  const a = idOf(first);
  const b = idOf(second);
  if (a && b && a !== b) counters[kind === 'debit' ? 'duplicate_debits_created' : 'duplicate_credits_created']++;
}

async function retriedDebits() {
  for (let i = 0; i < RETRY_ITERATIONS; i++) {
    const key = randomUUID();
    const first = await debit(meterName('RETRY-D', i), 4000, 'debit', key);
    await sleep(300); // a client retrying after a timeout
    const second = await debit(meterName('RETRY-D', i), 4000, 'debit', key);
    checkReplay('debit', first, second, debitId);
  }
}

async function retriedCredits() {
  for (let i = 0; i < RETRY_ITERATIONS; i++) {
    await debit(meterName('RETRY-C', i), 7000);
    await sleep(500);
    const key = randomUUID();
    const first = await credit(meterName('RETRY-C', i), 300_000, 'credit', key);
    await sleep(300);
    const second = await credit(meterName('RETRY-C', i), 300_000, 'credit', key);
    checkReplay('credit', first, second, creditId);
  }
}

// Two genuinely different 500,000-kobo repayments hit the same ₦7,000
// (700,000-kobo) debt at the same instant. The only correct outcome is
// exactly 700,000 recovered; more means the debt was reduced twice.
async function repaymentRace(seeded) {
  for (const meter of seeded) {
    const [a, b] = await Promise.all([credit(meter, 500_000, 'race'), credit(meter, 500_000, 'race')]);
    check('repayment race: no 5xx', a.status < 500 && b.status < 500);
    const recovered = [a, b].reduce((s, r) => s + (r.status === 201 ? num(r.json?.data?.summary?.totalRecoveredKobo) : 0), 0);
    if (!check('repayment race: exactly 700,000 kobo recovered per meter', recovered === 700_000) && recovered > 700_000) {
      counters.double_applied_repayments++;
      console.warn(`  DOUBLE-APPLIED REPAYMENT: ${meter} recovered ${recovered} on a 700000 debt`);
    }
    await sleep(500);
  }
}

// Two first advances for the same new meter at the same instant: at most one
// may be approved (one open advance per meter).
async function advanceRace() {
  for (let i = 0; i < RACE_ITERATIONS; i++) {
    const meter = meterName('RACE-D', i);
    const [a, b] = await Promise.all([debit(meter, 4000, 'race'), debit(meter, 4000, 'race')]);
    check('advance race: no 5xx', a.status < 500 && b.status < 500);
    const approvals = [a, b].filter((r) => r.status === 201).length;
    if (approvals > 1) {
      counters.concurrent_advances_approved++;
      console.warn(`  TWO ADVANCES APPROVED for ${meter}`);
    }
    await sleep(500);
  }
}

async function seedRaceDebts() {
  console.log(`  setting up ${RACE_ITERATIONS} debts for the repayment race test…`);
  const seeded = [];
  const reasons = [];
  for (let i = 0; i < RACE_ITERATIONS; i++) {
    const meter = meterName('RACE-C', i);
    // A random scoring decline creates nothing, so retry a few times — but if
    // nothing at all has been approved after 3 attempts, the declines are not
    // random: stop instead of spending minutes on doomed retries.
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await debit(meter, 7000, null);
      if (r.status === 201) {
        seeded.push(meter);
        break;
      }
      reasons.push(r.json?.reason ?? r.json?.message ?? `HTTP ${r.status}`);
      if (seeded.length === 0 && reasons.length >= 3) {
        console.warn(`  race test skipped: the first ${reasons.length} advances were all declined — "${reasons.at(-1)}"`);
        return seeded;
      }
    }
  }
  if (seeded.length < RACE_ITERATIONS) console.warn(`  only ${seeded.length}/${RACE_ITERATIONS} race debts could be created`);
  return seeded;
}

async function realistic() {
  console.log(`\n== Realistic load (${(210 * SCALE).toFixed(0)}s, plus a few seconds setting up the race test)`);
  startPhase('realistic');
  const seeded = await seedRaceDebts();
  const after = (s, fn) => sleep(s * SCALE * 1000).then(fn);
  await Promise.all([
    arrivalRate(debitFlow, constant(3), 0, 180),
    arrivalRate(creditFlow, constant(2), 30, 150),
    arrivalRate(readFlow, constant(5), 0, 180),
    arrivalRate(debitFlow, ramp([
      { target: 0, duration: 10 }, { target: 8, duration: 20 }, { target: 15, duration: 30 },
      { target: 8, duration: 20 }, { target: 0, duration: 10 },
    ]), 90, 90),
    after(45, retriedDebits),
    after(75, retriedCredits),
    after(60, () => repaymentRace(seeded)),
    after(20, advanceRace),
  ]);
  await Promise.all([...inflight]);
}

async function p95(meters) {
  console.log(`\n== §9.2 p95: ${CONCURRENCY} concurrent advance requests for ${P95_SECONDS}s`);
  startPhase('p95');
  // The previous phase can leave the app crashed or still digesting a
  // backlog; measuring p95 against that would only measure failures.
  const health = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(10_000) }).catch((e) => e);
  if (!(health instanceof Response) || !health.ok) {
    const why = health instanceof Response ? `HTTP ${health.status}` : `${health?.cause?.code ?? health?.name ?? health}`;
    console.log(`  skipped: the app is not answering ${BASE_URL}/api/health (${why}). Did it crash? Check its terminal.`);
    return { approvals: 0, declines: 0, failures: 0, skipped: true };
  }
  const end = performance.now() + P95_SECONDS * 1000;
  let next = 0;
  let approvals = 0;
  let declines = 0;
  let failures = 0;
  let stopEarly = false;
  const worker = async () => {
    while (performance.now() < end && next < meters.length && !stopEarly) {
      const n = next++;
      const r = await debit(meters[n], TIERS[n % TIERS.length], 'eligibility');
      if (r.status === 201) approvals++;
      else if (r.status === 200) declines++;
      else {
        failures++;
        if (failures <= 3) console.warn(`  unexpected ${r.status}: ${JSON.stringify(r.json).slice(0, 160)}`);
        // Nothing has worked at all: the app is down, stop hammering it.
        if (failures >= 50 && approvals + declines === 0 && !stopEarly) {
          stopEarly = true;
          console.log('  stopping the p95 test: the first 50 requests all failed (see the errors above).');
        }
      }
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (next >= meters.length && performance.now() < end) {
    console.log(`  used all ${meters.length} prepared meters after ${((performance.now() - started) / 1000).toFixed(0)}s (of ${P95_SECONDS}s); raise P95_METERS for a full-length run`);
  }
  return { approvals, declines, failures };
}

// ── Vend ingestion (VENDS=1 or ONLY=vends) ─────────────────────────────────
// Disco-side traffic: batches of vend events, as a disco's nightly/hourly
// upload would send them, including the messy parts real uploads have.
const VEND_BATCHES = Number(process.env.VEND_BATCHES || 20);
const VEND_BATCH_SIZE = Math.min(Number(process.env.VEND_BATCH_SIZE || 100), 500);
const VEND_CONCURRENCY = Number(process.env.VEND_CONCURRENCY || 4);
const VEND_METERS = Number(process.env.VEND_METERS || 50);
const VEND_SINGLES = Number(process.env.VEND_SINGLES || 20);
const METRICS_WAIT_SECONDS = Number(process.env.METRICS_WAIT_SECONDS || 90);
const DAY_MS = 24 * 60 * 60 * 1000;
const vendPrefix = `${RUN_ID}-V`;
const vendMeter = (n) => `STRESS-VEND-${RUN_ID}-${n}`;
let DISCO_HEADERS;

function makeVend(id) {
  return {
    partnerVendId: id,
    meterToken: vendMeter(randInt(0, VEND_METERS - 1)),
    amountKobo: randInt(500, 20_000) * 100,
    vendType: 'PREPAID_TOKEN',
    vendStatus: Math.random() < 0.1 ? 'FAILED' : 'SUCCESSFUL',
    // Inside the 60-day metrics window with room to spare.
    vendedAt: new Date(Date.now() - randInt(0, 55 * DAY_MS)).toISOString(),
  };
}

/** One batch: valid vends plus ~3% invalid rows and ~2% in-batch duplicates. */
function makeBatch(b) {
  const vends = [];
  const expected = []; // 'accepted' | 'rejected', by position
  const valid = [];
  for (let i = 0; vends.length < VEND_BATCH_SIZE; i++) {
    const roll = Math.random();
    if (roll < 0.03) {
      vends.push({ ...makeVend(`${vendPrefix}${b}-bad${i}`), amountKobo: -5 });
      expected.push('rejected');
    } else if (roll < 0.05 && valid.length > 0) {
      vends.push({ ...pick(valid) }); // same partnerVendId again in this batch
      expected.push('rejected');
    } else {
      const v = makeVend(`${vendPrefix}${b}-${i}`);
      vends.push(v);
      valid.push(v);
      expected.push('accepted');
    }
  }
  return { b, vends, expected, valid };
}

const vendCounters = { unexpected_vend_results: 0, vend_request_failures: 0 };
async function sendBatch(batch, vends = batch.vends) {
  const r = await http('POST', '/api/partners/vends/batch', { vends }, DISCO_HEADERS, 'vend-batch');
  if (!check('vend batch: 201', r.status === 201)) {
    vendCounters.vend_request_failures++;
    if (vendCounters.vend_request_failures <= 3) console.log(`  vend batch ${batch.b}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    return r;
  }
  const results = r.json?.results ?? [];
  let wrong = 0;
  batch.expected.forEach((want, i) => {
    if (results[i]?.status !== want) wrong++;
  });
  if (wrong > 0) {
    vendCounters.unexpected_vend_results += wrong;
    const sample = results.find((x, i) => x?.status !== batch.expected[i]);
    if (vendCounters.unexpected_vend_results === wrong) console.log(`  vend batch ${batch.b}: ${wrong} results not as expected, e.g. ${JSON.stringify(sample)}`);
  }
  check('vend batch: every row accepted/rejected as expected', wrong === 0);
  return r;
}

/** Runs async jobs with at most `limit` in flight. */
async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const running = fn(items[next++]);
      launch(running); // counted in the "in flight" progress figure
      await running;
    }
  });
  await Promise.all(workers);
}

async function vendScenario(discoId) {
  startPhase('vends');
  const phaseStart = new Date(Date.now() - 1000);
  const batches = Array.from({ length: VEND_BATCHES }, (_, b) => makeBatch(b));
  let expectedRejections = 0;

  // 1. First upload. Every 5th batch is sent twice at the same moment (a
  //    partner retrying before the first reply): both copies must come back
  //    with the same per-row answers, and nothing may be stored twice.
  console.log(`\n== Vends: ${VEND_BATCHES} batches × ${VEND_BATCH_SIZE}, ${VEND_CONCURRENCY} at a time (every 5th sent twice concurrently)`);
  await pool(batches, VEND_CONCURRENCY, async (batch) => {
    const copies = batch.b % 5 === 0 ? 2 : 1;
    await Promise.all(Array.from({ length: copies }, () => sendBatch(batch)));
    expectedRejections += copies * batch.expected.filter((x) => x === 'rejected').length;
  });

  // 2. Resends after the first upload finished: identical (no revision
  //    expected) and corrected amounts (exactly one revision per vend).
  const identical = batches.filter((x) => x.b % 5 === 1);
  const corrected = batches.filter((x) => x.b % 5 === 2);
  let expectedRevisions = 0;
  console.log(`  resending ${identical.length} batches unchanged and ${corrected.length} with corrected amounts`);
  await pool([...identical, ...corrected], VEND_CONCURRENCY, async (batch) => {
    const isCorrection = batch.b % 5 === 2;
    const vends = isCorrection
      ? batch.vends.map((v, i) => (batch.expected[i] === 'accepted' ? { ...v, amountKobo: v.amountKobo + 100 } : v))
      : batch.vends;
    await sendBatch(batch, vends);
    expectedRejections += batch.expected.filter((x) => x === 'rejected').length;
    if (isCorrection) expectedRevisions += batch.valid.length;
  });

  // 3. Single-vend endpoint.
  const singles = Array.from({ length: VEND_SINGLES }, (_, i) => makeVend(`${vendPrefix}S-${i}`));
  await pool(singles, VEND_CONCURRENCY, async (vend) => {
    const r = await http('POST', '/api/partners/vends', vend, DISCO_HEADERS, 'vend-single');
    if (!check('single vend: 201 accepted', r.status === 201 && r.json?.result?.status === 'accepted')) {
      vendCounters.vend_request_failures++;
      if (vendCounters.vend_request_failures <= 3) console.log(`  single vend: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    }
  });

  // ── What the database must now hold ──
  const expectedIds = new Set([...batches.flatMap((x) => x.valid.map((v) => v.partnerVendId)), ...singles.map((v) => v.partnerVendId)]);
  const where = { discoAdminId: discoId, partnerVendId: { startsWith: vendPrefix } };
  const stored = await prisma.vendRecord.count({ where });
  const revisions = await prisma.vendRecordRevision.count({ where: { vendRecord: where } });
  const failures = await prisma.vendIngestionFailure.count({
    where: { discoAdminId: discoId, submittedPartnerVendId: { startsWith: vendPrefix }, createdAt: { gte: phaseStart } },
  });
  console.log(`  stored ${stored} (expected ${expectedIds.size}), revisions ${revisions} (expected ${expectedRevisions}), failure log rows ${failures} (expected ${expectedRejections})`);

  // Final amounts: corrected batches must hold the corrected amount.
  const correctedWant = new Map(corrected.flatMap((x) => x.valid.map((v) => [v.partnerVendId, v.amountKobo + 100])));
  let wrongAmounts = 0;
  if (correctedWant.size > 0) {
    const rows = await prisma.vendRecord.findMany({ where: { discoAdminId: discoId, partnerVendId: { in: [...correctedWant.keys()] } }, select: { partnerVendId: true, amountKobo: true } });
    wrongAmounts = rows.filter((r) => r.amountKobo !== correctedWant.get(r.partnerVendId)).length + (correctedWant.size - rows.length);
  }

  // ── Metrics: the worker must process every vend and catch up ──
  console.log(`  waiting up to ${METRICS_WAIT_SECONDS}s for the vend-metrics worker to process everything…`);
  const waitStart = performance.now();
  let pending = Infinity;
  let lastPending = null;
  while (performance.now() - waitStart < METRICS_WAIT_SECONDS * 1000) {
    pending = await prisma.vendRecord.count({ where: { ...where, processingStatus: 'Pending' } });
    if (pending === 0) break;
    if (pending !== lastPending) console.log(`    ${pending} vends still Pending (${mmss(performance.now() - waitStart)})`);
    lastPending = pending;
    await sleep(3000);
  }
  const lagMs = performance.now() - waitStart;
  if (pending > 0) {
    console.log(`  ${pending} vends still Pending after ${METRICS_WAIT_SECONDS}s.`);
    if (pending === stored) {
      console.log('  → None were processed: monsera-vend-ingestion\'s workers are not running (RUN_WORKERS=false?),');
      console.log('    or it uses a different REDIS_URL / BULLMQ_PREFIX than the instance that queued the jobs.');
    } else {
      console.log('  → Some were processed: either the worker is slow (raise METRICS_WAIT_SECONDS) or jobs were dropped.');
    }
  } else {
    console.log(`  all processed ${(lagMs / 1000).toFixed(1)}s after the last upload`);
  }

  // Every touched meter has metrics, and the successful-vend count matches
  // what is stored (worker rule: SUCCESSFUL vends in the last 60 days).
  const touchedMeters = [...new Set([...batches.flatMap((x) => x.valid), ...singles].map((v) => v.meterToken))];
  const metrics = await prisma.customerVendMetrics.findMany({ where: { meterToken: { in: touchedMeters } }, select: { meterToken: true, vendCountLast60Days: true } });
  const counts = await prisma.vendRecord.groupBy({
    by: ['meterToken'],
    where: { meterToken: { in: touchedMeters }, vendStatus: 'SUCCESSFUL', vendedAt: { gte: new Date(Date.now() - 60 * DAY_MS) } },
    _count: { _all: true },
  });
  const wantCount = new Map(counts.map((c) => [c.meterToken, c._count._all]));
  const staleMeters = metrics.filter((m) => m.vendCountLast60Days !== (wantCount.get(m.meterToken) ?? 0)).length;
  const missingMeters = touchedMeters.length - metrics.length;
  console.log(`  metrics: ${metrics.length}/${touchedMeters.length} meters have a row, ${staleMeters} with a stale vend count`);

  return [
    ['vends: every row accepted/rejected as expected, no failed requests', vendCounters.unexpected_vend_results === 0 && vendCounters.vend_request_failures === 0],
    [`vends: each accepted vend stored exactly once (${stored}/${expectedIds.size})`, stored === expectedIds.size],
    [`vends: one revision per corrected vend, none for identical resends (${revisions}/${expectedRevisions})`, revisions === expectedRevisions && wrongAmounts === 0],
    [`vends: every rejected row in the failure log (${failures}/${expectedRejections})`, failures === expectedRejections],
    [`vends: worker processed every vend within ${METRICS_WAIT_SECONDS}s${pending === 0 ? ` (${(lagMs / 1000).toFixed(1)}s)` : ` (${pending} Pending)`}`, pending === 0],
    ['vends: metrics up to date for every touched meter', missingMeters === 0 && staleMeters === 0],
  ];
}

// ── Vend history for the stress meters ─────────────────────────────────────
// A real scoring engine refuses meters with no vend history (the app sends
// all-zero features, which it reads as inconsistent). So before any advance,
// every meter the run will use gets a realistic history uploaded through the
// vend endpoint, and the run waits for the vend-metrics worker to turn it
// into features. Meters that already have features are left alone.
const VEND_HISTORY = Number(process.env.VEND_HISTORY || 15);
const HISTORY_WAIT_SECONDS = Number(process.env.HISTORY_WAIT_SECONDS || 600);
const historyPrefix = `${RUN_ID}-H`;

function historyFor(meterToken, m) {
  const count = randInt(Math.max(3, VEND_HISTORY - 3), VEND_HISTORY + 3);
  const baseKobo = randInt(20, 100) * 100 * 100; // a typical top-up of ₦2,000–₦10,000
  const spacingDays = 55 / count;
  return Array.from({ length: count }, (_, k) => {
    // Newest vend 1–3 days ago, the rest spread back over ~55 days.
    const daysAgo = k === 0 ? 1 + Math.random() * 2 : 1 + k * spacingDays + (Math.random() - 0.5) * spacingDays * 0.6;
    return {
      partnerVendId: `${historyPrefix}${m}-${k}`,
      meterToken,
      amountKobo: Math.round((baseKobo * (0.8 + Math.random() * 0.4)) / 100) * 100,
      vendType: 'PREPAID_TOKEN',
      vendStatus: k > 0 && Math.random() < 0.03 ? 'FAILED' : 'SUCCESSFUL',
      vendedAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    };
  });
}

async function chunkedCount(meters, query) {
  let total = 0;
  for (let i = 0; i < meters.length; i += 5000) total += await query(meters.slice(i, i + 5000));
  return total;
}

async function seedVendHistory(meters) {
  startPhase('history');
  const have = new Set();
  for (let i = 0; i < meters.length; i += 5000) {
    const rows = await prisma.customerVendMetrics.findMany({ where: { meterToken: { in: meters.slice(i, i + 5000) } }, select: { meterToken: true } });
    rows.forEach((r) => have.add(r.meterToken));
  }
  const need = meters.filter((m) => !have.has(m));
  console.log(`\n== Vend history (${meters.length} meters, ${have.size} already have features)`);
  if (need.length === 0) return;

  const vends = need.flatMap((meter, m) => historyFor(meter, m));
  const batches = [];
  for (let i = 0; i < vends.length; i += 500) batches.push(vends.slice(i, i + 500));
  console.log(`  uploading ${vends.length} vends for ${need.length} meters in ${batches.length} batches…`);
  let uploadFailures = 0;
  await pool(batches, VEND_CONCURRENCY, async (batch) => {
    const r = await http('POST', '/api/partners/vends/batch', { vends: batch }, DISCO_HEADERS, 'vend-history');
    if (r.status !== 201 || r.json?.failed !== 0) {
      uploadFailures++;
      if (uploadFailures <= 3) console.log(`  history upload: HTTP ${r.status} ${JSON.stringify(r.json?.message ?? r.json?.results?.find((x) => x.status !== 'accepted') ?? r.json).slice(0, 200)}`);
    }
  });
  if (uploadFailures > 0) fail(`${uploadFailures} vend-history uploads failed (see above). Stopping before any advance.`);

  console.log(`  waiting up to ${HISTORY_WAIT_SECONDS}s for the vend-metrics worker to build features…`);
  const waitStart = performance.now();
  let pending;
  let ready;
  let lastLine = '';
  let lastChange = performance.now();
  let lastPrinted = 0;
  let warnedStall = false;
  while (true) {
    pending = await prisma.vendRecord.count({ where: { discoAdminId: STRESS.discoId, partnerVendId: { startsWith: historyPrefix }, processingStatus: 'Pending' } });
    ready = await chunkedCount(need, (chunk) => prisma.customerVendMetrics.count({ where: { meterToken: { in: chunk } } }));
    if (pending === 0 && ready === need.length) break;
    const line = `    ${ready}/${need.length} meters have features, ${pending} vends still Pending`;
    const now = performance.now();
    if (line !== lastLine) lastChange = now;
    // Print on change, and at least every 30s so a stall is visible.
    if (line !== lastLine || now - lastPrinted > 30_000) {
      console.log(`${line} (${mmss(now - waitStart)}${line === lastLine ? `, no progress for ${mmss(now - lastChange)}` : ''})`);
      lastPrinted = now;
    }
    lastLine = line;
    if (!warnedStall && now - lastChange > 60_000) {
      warnedStall = true;
      console.log('  ! No progress for 60s while vends are still Pending. The usual cause: the app\'s queue jobs are being');
      console.log('    taken by ANOTHER app\'s workers on the same Redis (e.g. the live app), which look the meters up in');
      console.log('    their own database. Give this app its own Redis database (REDIS_URL ending /1) or BULLMQ_PREFIX.');
    }
    if (performance.now() - waitStart > HISTORY_WAIT_SECONDS * 1000) {
      if (pending === vends.length) {
        fail('No vend was processed: monsera-vend-ingestion\'s queue workers are not running (RUN_WORKERS=false?), or it uses a different REDIS_URL / BULLMQ_PREFIX.');
      }
      fail(`The worker is still behind after ${HISTORY_WAIT_SECONDS}s. Raise HISTORY_WAIT_SECONDS, or lower P95_METERS so there is less history to build.`);
    }
    await sleep(5000);
  }
  console.log(`  features ready for ${need.length} meters after ${mmss(performance.now() - waitStart)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const health = await fetch(`${BASE_URL}/api/health`).catch(() => null);
  if (!health?.ok) fail(`The platform is not healthy at ${BASE_URL}/api/health (the gateway reports each service) — start it first (docker compose up --build).`);

  const dbLabel = (() => {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}${u.pathname}`;
  })();
  console.log(`Monsera stress test — run ${RUN_ID}`);
  console.log(`  app:      ${BASE_URL}`);
  console.log(`  database: ${dbLabel} (from .env; existing data is kept)`);
  const envRedis = process.env.REDIS_URL || '';
  if (envRedis && !/^redis:\/\/(localhost|127\.0\.0\.1)/.test(envRedis)) {
    console.log(`  note:     REDIS_URL in .env is not local (${new URL(envRedis).hostname}). Start the APP with`);
    console.log(`            BULLMQ_PREFIX=stress so its queue jobs stay apart from the live app's.`);
  }
  console.log(`  progress: a status line every ${PROGRESS_SECONDS}s; finished when it prints ALL PASSED or FAILED`);
  if (RATE !== 1) console.log(`  rate:     ×${RATE} of the normal load`);

  const runRealistic = !ONLY || ONLY === 'realistic';
  const runP95 = !ONLY || ONLY === 'p95';
  const runVends = ONLY === 'vends' || process.env.VENDS === '1';
  const runMoney = runRealistic || runP95;
  if (ONLY && !['realistic', 'p95', 'vends'].includes(ONLY)) fail(`ONLY must be realistic, p95 or vends (got "${ONLY}")`);
  // Enough fresh meters for the p95 run (each request is a first advance).
  const p95Meters = runP95 ? Array.from({ length: P95_METERS }, (_, n) => meterName('P95', n)) : [];

  console.log('\n== Setup (adds stress accounts, meters and a Wallet A top-up)');
  const { aggUser, discoUser, disco } = await setup(p95Meters, { topup: runMoney });
  DISCO_HEADERS = {
    Authorization: `Bearer ${jwt.sign({ userId: discoUser.id, email: discoUser.email, userType: 'DISCO_ADMIN' }, process.env.JWT_SECRET, { expiresIn: '2h' })}`,
    'API-Key': STRESS.disco.apiKey,
  };
  HEADERS = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt.sign({ userId: aggUser.id, email: aggUser.email, userType: 'AGGREGATOR' }, process.env.JWT_SECRET, { expiresIn: '2h' })}`,
    'API-Key': STRESS.aggregator.apiKey,
  };
  const probe = await http('GET', '/api/transactions?page=1&limit=1');
  if (probe.status === 401) fail('The app rejected the stress login: is the app using the same JWT_SECRET and database as this .env?');
  console.log(`  disco: ${STRESS.discoName}; Wallet A top-up: ₦${(runMoney ? TOPUP_NAIRA : 0).toLocaleString()}`);

  // Pre-flight: one advance on a fresh cohort meter. If the app declines it,
  // nearly every advance in the run will be declined too, and the money
  // checks would pass without testing anything — so stop and say why.
  if (runMoney) {
    // Every meter an advance will be requested for.
    const advanceMeters = [...METER_POOL, meterName('PREFLIGHT', 0), ...p95Meters];
    for (let i = 0; i < RETRY_ITERATIONS; i++) advanceMeters.push(meterName('RETRY-D', i), meterName('RETRY-C', i));
    for (let i = 0; i < RACE_ITERATIONS; i++) advanceMeters.push(meterName('RACE-C', i), meterName('RACE-D', i));
    await seedVendHistory(runRealistic ? advanceMeters : [meterName('PREFLIGHT', 0), ...p95Meters]);

    console.log('\n== Pre-flight (one test advance)');
    const pre = await debit(meterName('PREFLIGHT', 0), 2000, null);
    if (pre.status === 201) {
      console.log(`  approved in ${pre.ms.toFixed(0)}ms — scoring engine and disbursement path are working`);
    } else {
      const reason = pre.json?.reason ?? pre.json?.message ?? JSON.stringify(pre.json);
      console.log(`  NOT approved (HTTP ${pre.status}, ${pre.ms.toFixed(0)}ms): ${reason}`);
      const hint =
        /scoring service unavailable|scoring engine error/i.test(reason)
          ? 'The app cannot reach its scoring engine. Check SCORING_ENGINE_URL / SCORING_ENGINE_SECRET in .env (then restart the app), or run the mock: node stress/mock-scoring-engine.js and set SCORING_ENGINE_URL=http://localhost:4001.'
          : /suspended|temporarily unavailable/i.test(reason)
            ? 'A feature flag is off in this database (disbursements_enabled or scoring_engine_enabled). Turn it on via /api/admin/flags or the FeatureFlag table.'
            : /inconsistent|feature/i.test(reason)
            ? 'The engine rejected the feature data even though this meter now has a vend history. A likely cause: a first-time customer has no Customer record yet, so the app sends meter_status "Unknown". Check with the scoring-engine owner which feature it rejects.'
          : /cohort/i.test(reason)
              ? 'The meter was not found in the cohort — is the app using the same DATABASE_URL as this .env?'
              : /exhausted/i.test(reason)
                ? 'Wallet A has no float: keep TOPUP_NAIRA above 0, and make sure WALLET_A_ID matches the app.'
                : 'The scoring engine declined a meter that has a typical vend history. Check the engine\'s rules, or try VEND_HISTORY=25 for a stronger history.';
      console.log(`  → ${hint}`);
      if (process.env.ALLOW_DECLINES !== '1') {
        console.log('  Stopping before the load. Set ALLOW_DECLINES=1 to run anyway (the money checks will have little to test).');
        return false;
      }
    }
  }

  console.log('\n== Baseline (before load)');
  const before = await invariants();
  const identityBefore = await identityKobo();
  for (const [name, v] of Object.entries(before)) if (v !== 0) console.log(`  already non-zero before the run: ${name} = ${v}`);
  console.log(`  identity difference before: ${identityBefore} kobo`);

  const ticker = setInterval(printProgress, PROGRESS_SECONDS * 1000);
  let p95Result = null;
  let vendResults = [];
  try {
    if (runRealistic) await realistic();
    p95Result = runP95 ? await p95(p95Meters) : null;
    if (runVends) vendResults = await vendScenario(disco.id);
  } finally {
    clearInterval(ticker);
  }

  console.log('\n== Verify (after load)');
  const after = await invariants();
  const identityAfter = await identityKobo();
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  for (const k of changed) console.log(`  CHANGED by the run: ${k}: ${before[k]} -> ${after[k]}`);
  console.log(`  identity difference after:  ${identityAfter} kobo (change ${identityAfter - identityBefore})`);

  // ── Report ──
  console.log('\n== Timings (ms)');
  for (const [kind, values] of Object.entries(durations)) {
    console.log(`  ${kind.padEnd(12)} n=${String(values.length).padStart(5)}  med=${percentile(values, 50).toFixed(0).padStart(5)}  p95=${percentile(values, 95).toFixed(0).padStart(5)}  p99=${percentile(values, 99).toFixed(0).padStart(5)}  max=${Math.max(...values).toFixed(0).padStart(5)}`);
  }
  if (Object.keys(declineReasons).length > 0) {
    console.log('\n== Decline reasons (advances answered with HTTP 200 "declined")');
    for (const [reason, n] of Object.entries(declineReasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${reason}`);
  }
  if (networkRetries.count) {
    console.log(`\n  note: ${networkRetries.count} requests were retried after a network error on this machine (last: ${networkRetries.lastCode}); they never reached the app.`);
  }
  console.log('\n== Checks');
  for (const [name, c] of Object.entries(checks)) console.log(`  ${c.fail === 0 ? '✓' : '✗'} ${name}  (${c.pass} ok, ${c.fail} failed)`);
  for (const [name, v] of Object.entries(counters)) console.log(`  ${v === 0 ? '✓' : '✗'} ${name} = ${v}`);

  const results = [];
  const rate = (name, max) => {
    const c = checks[name];
    if (!c) return true;
    return c.fail / (c.pass + c.fail) <= max;
  };
  results.push(['no server errors (5xx / timeouts)', counters.server_errors === 0]);
  results.push(['no double-applied repayments', counters.double_applied_repayments === 0]);
  results.push(['no meter got two concurrent advances', counters.concurrent_advances_approved === 0]);
  results.push(['idempotent retries replayed, no duplicates',
    counters.idempotency_replay_missing === 0 && counters.duplicate_debits_created === 0 && counters.duplicate_credits_created === 0]);
  results.push(['request checks within thresholds', rate('debit: 201 approved or 200 declined', 0.05) && rate('credit: 201, or 404 when nothing is owed', 0.15) && rate('list: 200', 0.01) && rate('detail: 200', 0.01)]);
  results.push(['ledger invariants unchanged by the run', changed.length === 0]);
  results.push(['reconciliation identity unchanged by the run', Math.abs(identityAfter - identityBefore) <= 1]);
  if (p95Result) {
    const p = percentile(durations.eligibility ?? [], 95);
    console.log(`\n  p95 run: ${p95Result.approvals} approved, ${p95Result.declines} declined, ${p95Result.failures} failed`);
    results.push(p95Result.skipped
      ? ['§9.2 eligibility p95 (skipped: app not answering)', false]
      : [`§9.2 eligibility p95 < 800ms at ${CONCURRENCY} concurrent (got ${p.toFixed(0)}ms${p95Result.failures ? `, but ${p95Result.failures} requests failed` : ''})`, p < 800 && p95Result.failures === 0]);
  }

  results.push(...vendResults);

  console.log('\n== Result');
  for (const [name, ok] of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  const passed = results.every(([, ok]) => ok);
  console.log(`\n${passed ? 'ALL PASSED' : 'FAILED'}`);
  return passed;
}

main()
  .then((passed) => (process.exitCode = passed ? 0 : 1))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
