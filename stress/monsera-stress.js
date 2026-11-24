import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Configuration. Everything comes from environment variables.
// ---------------------------------------------------------------------------
const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PROFILE = __ENV.PROFILE || 'smoke';
const SCENARIOS = (__ENV.SCENARIOS || 'reads,vend').split(',').map((s) => s.trim()).filter(Boolean);
const RATE_SCALE = Number(__ENV.RATE_SCALE || 1); // multiplies every rate in the profile
const MAX_VUS = Number(__ENV.MAX_VUS || 200);
const METER_POOL = Number(__ENV.METER_POOL || 500); // how many distinct meters the vend scenarios reuse
const BATCH_SIZE = Math.min(Number(__ENV.BATCH_SIZE || 100), 500);
const DISCO_NAME = __ENV.DISCO_NAME || ''; // only needed if you log in as an AGGREGATOR

const WRITE_SCENARIOS = ['vend', 'batch', 'debitcredit', 'idempotency', 'race'];
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);

// Target iterations per second at each stage.
const PROFILES = {
  smoke: [{ duration: '30s', target: 1 }],
  load: [
    { duration: '1m', target: 10 },
    { duration: '5m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  stress: [
    { duration: '1m', target: 10 },
    { duration: '2m', target: 25 },
    { duration: '2m', target: 50 },
    { duration: '2m', target: 100 },
    { duration: '1m', target: 0 },
  ],
  spike: [
    { duration: '1m', target: 5 },
    { duration: '10s', target: 100 },
    { duration: '1m', target: 100 },
    { duration: '10s', target: 5 },
    { duration: '1m', target: 5 },
  ],
  soak: [
    { duration: '2m', target: 10 },
    { duration: '30m', target: 10 },
    { duration: '1m', target: 0 },
  ],
};

// Each scenario is a share of the profile's rate. A batch iteration carries many vends,
// and a debit+credit iteration makes two requests, so they run less often.
const WEIGHTS = { reads: 1, vend: 1, batch: 0.1, debitcredit: 0.3, idempotency: 0.1, race: 0.1 };
const EXEC = {
  reads: 'reads',
  vend: 'vendSingle',
  batch: 'vendBatch',
  debitcredit: 'debitCredit',
  idempotency: 'idempotencyReplay',
  race: 'sameMeterRace',
};

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const vendsSent = new Counter('vends_sent'); // compare with the VendRecord count in the database
const debitsApproved = new Counter('debits_approved'); // compare with debit rows in the database
const debitsDeclined = new Counter('debits_declined'); // tagged by decline reason
const creditsOk = new Counter('credits_ok');
const idempotencyViolations = new Counter('idempotency_violations'); // must stay 0
const idempotencyRace5xx = new Counter('idempotency_race_5xx'); // known gap: the loser of a same-key race
const unexpectedResponses = new Counter('unexpected_responses');

function buildScenarios() {
  if (!PROFILES[PROFILE]) {
    throw new Error(`Unknown PROFILE "${PROFILE}". Use: ${Object.keys(PROFILES).join(', ')}`);
  }
  const scenarios = {};
  for (const name of SCENARIOS) {
    if (!EXEC[name]) {
      throw new Error(`Unknown scenario "${name}". Use: ${Object.keys(EXEC).join(', ')}`);
    }
    const weight = WEIGHTS[name] * RATE_SCALE;
    // Rates are per minute so that small weights (0.1 per second) still round to a whole number.
    const stages = PROFILES[PROFILE].map((s) => ({
      duration: s.duration,
      target: Math.max(0, Math.round(s.target * 60 * weight)),
    }));
    scenarios[name] = {
      executor: 'ramping-arrival-rate',
      exec: EXEC[name],
      timeUnit: '1m',
      startRate: Math.max(1, Math.round(stages[0].target / 2)),
      preAllocatedVUs: Math.min(20, MAX_VUS),
      maxVUs: MAX_VUS,
      stages,
    };
  }
  return scenarios;
}

export const options = {
  scenarios: buildScenarios(),
  thresholds: {
    http_req_failed: ['rate<0.02'],
    'http_req_duration{scenario:reads}': ['p(95)<800'],
    'http_req_duration{scenario:vend}': ['p(95)<1000'],
    'http_req_duration{scenario:batch}': ['p(95)<3000'],
    'http_req_duration{scenario:debitcredit}': ['p(95)<3000'],
    idempotency_violations: ['count==0'],
    unexpected_responses: ['count==0'],
    // Any dropped iteration means the server (or MAX_VUS) could not keep up with the planned rate.
    dropped_iterations: ['count==0'],
    obligation_violations: ['count==0'],
    idempotency_race_5xx: ['count==0'], // known gap: the loser of a same-key race may get a 502 from the proxy
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function safeJson(res, selector) {
  try {
    return selector ? res.json(selector) : res.json();
  } catch (e) {
    return undefined; // not JSON, for example an HTML 502 from the proxy
  }
}

// Debug logging: prints the status and start of the body for the first few failed
// requests. `logged` is per VU (each VU has its own copy of script globals), so a run
// can print up to MAX_FAIL_LOGS lines per VU. Status 0 means a connection error.
const MAX_FAIL_LOGS = 10;
let logged = 0;
function logFail(name, res) {
  if ((res.status === 0 || res.status >= 400) && logged < MAX_FAIL_LOGS) {
    logged++;
    console.error(`${name}: HTTP ${res.status} ${String(res.body).slice(0, 300)}`);
  }
}

function jsonHeaders(token, extra) {
  return Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, extra || {});
}

function discoHeaders(data, extra) {
  return jsonHeaders(data.discoToken, Object.assign({ 'API-Key': __ENV.API_KEY }, extra || {}));
}

function login(email, password) {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const token = res.status === 200 || res.status === 201 ? safeJson(res, 'data.token') : undefined;
  if (!token) fail(`Login failed for ${email}: HTTP ${res.status} ${res.body}`);
  return token;
}

function makeVend(runId, suffix) {
  return {
    partnerVendId: `STRESS-${runId}-${__VU}-${__ITER}${suffix !== undefined ? `-${suffix}` : ''}`,
    meterToken: `STRESS-METER-${randomInt(0, METER_POOL - 1)}`,
    amountKobo: randomInt(100, 1000) * 1000,
    vendType: 'PREPAID_TOKEN',
    vendStatus: Math.random() < 0.9 ? 'SUCCESSFUL' : 'FAILED',
    vendedAt: new Date(Date.now() - randomInt(0, 72) * 3600 * 1000).toISOString(),
  };
}

function moneyBody(meterToken, extra) {
  return JSON.stringify(Object.assign({ meterToken }, extra, DISCO_NAME ? { disco: DISCO_NAME } : {}));
}

// ---------------------------------------------------------------------------
// Setup: runs once. It checks the safety rule and logs in.
// ---------------------------------------------------------------------------
export function setup() {
  const writes = SCENARIOS.filter((s) => WRITE_SCENARIOS.includes(s));

  if (!IS_LOCAL && writes.length > 0 && __ENV.CONFIRM_REMOTE_WRITES !== 'yes') {
    fail(
      `Refusing to run write scenarios (${writes.join(', ')}) against ${BASE_URL}. ` +
        'They create real rows and move wallet balances there. If that is intended, set CONFIRM_REMOTE_WRITES=yes.',
    );
  }

  const data = { runId: Date.now().toString(36), discoToken: null, adminToken: null };

  if (writes.length > 0) {
    if (!__ENV.DISCO_EMAIL || !__ENV.DISCO_PASSWORD || !__ENV.API_KEY) {
      fail('Write scenarios need DISCO_EMAIL, DISCO_PASSWORD and API_KEY.');
    }
    data.discoToken = login(__ENV.DISCO_EMAIL, __ENV.DISCO_PASSWORD);
  }

  if (SCENARIOS.includes('reads')) {
    if (__ENV.ADMIN_EMAIL && __ENV.ADMIN_PASSWORD) {
      data.adminToken = login(__ENV.ADMIN_EMAIL, __ENV.ADMIN_PASSWORD);
    } else {
      console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set: the reads scenario will do nothing.');
    }
  }

  console.log(`Run ${data.runId}: ${PROFILE} profile against ${BASE_URL}, scenarios: ${SCENARIOS.join(', ')}`);
  return data;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// Read-only admin traffic. Safe to run against production.
export function reads(data) {
  if (!data.adminToken) return;
  const headers = jsonHeaders(data.adminToken);

  const list = http.get(`${BASE_URL}/admin/meters?limit=25&page=${randomInt(1, 50)}`, {
    headers,
    tags: { name: 'GET /admin/meters' },
  });
  logFail('meters list', list);
  if (!check(list, { 'meters list: 200': (r) => r.status === 200 })) unexpectedResponses.add(1);

  const items = list.status === 200 ? safeJson(list, 'data.items') : [];
  if (items && items.length > 0) {
    const meter = items[randomInt(0, items.length - 1)].meterToken;
    const one = http.get(`${BASE_URL}/admin/meters/${meter}`, {
      headers,
      tags: { name: 'GET /admin/meters/:meterToken' },
    });
    logFail('meter detail', one);
    if (!check(one, { 'meter detail: 200': (r) => r.status === 200 })) unexpectedResponses.add(1);
  }
}

// One vend per request, the traffic you expect from a partner.
export function vendSingle(data) {
  const res = http.post(`${BASE_URL}/partners/vends`, JSON.stringify(makeVend(data.runId)), {
    headers: discoHeaders(data),
    tags: { name: 'POST /partners/vends' },
  });
  logFail('vend', res);
  vendsSent.add(1);
  const ok = check(res, { 'vend: 201 and accepted': (r) => r.status === 201 && safeJson(r, 'success') === true });
  if (!ok) unexpectedResponses.add(1);
}

// A batch of vends per request, such as a partner's catch-up push.
export function vendBatch(data) {
  const vends = [];
  for (let i = 0; i < BATCH_SIZE; i++) vends.push(makeVend(data.runId, i));

  const res = http.post(`${BASE_URL}/partners/vends/batch`, JSON.stringify({ vends }), {
    headers: discoHeaders(data),
    tags: { name: 'POST /partners/vends/batch' },
  });
  logFail('batch', res);
  vendsSent.add(BATCH_SIZE);
  const ok = check(res, {
    'batch: 201 and nothing rejected': (r) => r.status === 201 && safeJson(r, 'failed') === 0,
  });
  if (!ok) unexpectedResponses.add(1);
}

// A debit on a brand-new meter, then a full or partial repayment.
export function debitCredit(data) {
  const meterToken = `STRESS-${data.runId}-${__VU}-${__ITER}`;
  const amount = 2000 + randomInt(0, 50) * 100; // naira, inside the 2,000 to 7,000 limits
  const key = `${data.runId}-${__VU}-${__ITER}`;

  const debit = http.post(`${BASE_URL}/transactions/debit`, moneyBody(meterToken, { amount }), {
    headers: discoHeaders(data, { 'Idempotency-Key': `dbt-${key}` }),
    tags: { name: 'POST /transactions/debit' },
  });
  logFail('debit', debit);
  const debitBody = safeJson(debit);
  if (!check(debit, { 'debit: 200 or 201': (r) => r.status === 200 || r.status === 201 }) || !debitBody) {
    unexpectedResponses.add(1);
    return;
  }
  if (debitBody.decision !== 'approved') {
    debitsDeclined.add(1, { reason: String(debitBody.reason || 'unknown').slice(0, 40) });
    console.error(`debit declined: ${String(debit.body).slice(0, 300)}`);
    return;
  }
  debitsApproved.add(1);

  const obligationKobo = amount * 100;
  const payKobo = Math.random() < 0.5 ? obligationKobo : Math.floor(obligationKobo / 2);
  const credit = http.post(`${BASE_URL}/transactions/credit`, moneyBody(meterToken, { amountKobo: payKobo }), {
    headers: discoHeaders(data, { 'Idempotency-Key': `crd-${key}` }),
    tags: { name: 'POST /transactions/credit' },
  });
  logFail('credit', credit);
  const recovered = safeJson(credit, 'data.summary.totalRecoveredKobo');
  const ok = check(credit, {
    'credit: 201': (r) => r.status === 201,
    'credit: recovered exactly what was paid': () => recovered === payKobo,
  });
  if (ok) creditsOk.add(1);
  else unexpectedResponses.add(1);
}

// Fires the same debit three times at once with one Idempotency-Key.
// At most one transaction may ever come out of it.
export function idempotencyReplay(data) {
  const meterToken = `STRESS-IDEM-${data.runId}-${__VU}-${__ITER}`;
  const url = `${BASE_URL}/transactions/debit`;
  const body = moneyBody(meterToken, { amount: 3000 });
  const params = {
    headers: discoHeaders(data, { 'Idempotency-Key': `idem-${data.runId}-${__VU}-${__ITER}` }),
    tags: { name: 'POST /transactions/debit (same key x3)' },
  };

  const responses = http.batch([
    ['POST', url, body, params],
    ['POST', url, body, params],
    ['POST', url, body, params],
  ]);

  const transactionIds = {};
  for (const r of responses) {
    logFail('idempotency', r);
    if (r.status >= 500) {
      idempotencyRace5xx.add(1);
      continue;
    }
    const id = safeJson(r, 'data.transaction.transactionId');
    if (id) transactionIds[id] = true;
  }
  if (Object.keys(transactionIds).length > 1) idempotencyViolations.add(1);
}

export function teardown(data) {
  console.log(
    `\nRun ${data.runId} finished. Test rows use the prefix STRESS-. ` +
      'Compare vends_sent, debits_approved and credits_ok with the database, then clean up.',
  );
}

const obligationViolations = new Counter('obligation_violations'); // must stay 0

// Same meter, three different keys at once. At most one may be approved.
export function sameMeterRace(data) {
  const meterToken = `STRESS-RACE-${data.runId}-${__VU}-${__ITER}`;
  const url = `${BASE_URL}/transactions/debit`;
  const body = moneyBody(meterToken, { amount: 3000 });
  const params = (n) => ({
    headers: discoHeaders(data, { 'Idempotency-Key': `race-${data.runId}-${__VU}-${__ITER}-${n}` }),
    tags: { name: 'POST /transactions/debit (same meter x3)' },
  });
  const rs = http.batch([['POST', url, body, params(0)], ['POST', url, body, params(1)], ['POST', url, body, params(2)]]);

  let approved = 0;
  for (const r of rs) {
    logFail('race', r);
    if (r.status >= 500) { unexpectedResponses.add(1); continue; }
    if (safeJson(r, 'decision') === 'approved') approved++;
  }
  if (approved > 1) obligationViolations.add(1);
}