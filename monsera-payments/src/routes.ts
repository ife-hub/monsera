// Generated from src/app/api by the port tooling. Each entry mounts one
// route handler module at its URL (see route-adapter.ts).
import type { RouteEntry } from './route-adapter';
import * as r0 from './app/api/burn-rates/route';
import * as r1 from './app/api/cohort/route';
import * as r2 from './app/api/credit-parameters/route';
import * as r3 from './app/api/cron/cleanup/route';
import * as r4 from './app/api/cron/monthly-reconciliation/route';
import * as r5 from './app/api/cron/obligation-status/route';
import * as r6 from './app/api/cron/reconciliation/route';
import * as r7 from './app/api/cron/settlement/route';
import * as r8 from './app/api/cron/sweep/route';
import * as r9 from './app/api/obligations/suspensions/route';
import * as r10 from './app/api/recovery-window-parameters/route';
import * as r11 from './app/api/transactions/route';
import * as r12 from './app/api/transactions/credit/route';
import * as r13 from './app/api/transactions/debit/route';
import * as r14 from './app/api/wallet/route';
import * as r15 from './app/api/transactions/[id]/route';
import * as r16 from './app/api/wallet/[id]/route';
import * as r17 from './app/api/wallet/add/[id]/route';
import * as r18 from './app/api/wallet/subtract/[id]/route';

export const ROUTES: RouteEntry[] = [
  { path: '/api/burn-rates', module: r0 },
  { path: '/api/cohort', module: r1 },
  { path: '/api/credit-parameters', module: r2 },
  { path: '/api/cron/cleanup', module: r3 },
  { path: '/api/cron/monthly-reconciliation', module: r4 },
  { path: '/api/cron/obligation-status', module: r5 },
  { path: '/api/cron/reconciliation', module: r6 },
  { path: '/api/cron/settlement', module: r7 },
  { path: '/api/cron/sweep', module: r8 },
  { path: '/api/obligations/suspensions', module: r9 },
  { path: '/api/recovery-window-parameters', module: r10 },
  { path: '/api/transactions', module: r11 },
  { path: '/api/transactions/credit', module: r12 },
  { path: '/api/transactions/debit', module: r13 },
  { path: '/api/wallet', module: r14 },
  { path: '/api/transactions/:id', module: r15 },
  { path: '/api/wallet/:id', module: r16 },
  { path: '/api/wallet/add/:id', module: r17 },
  { path: '/api/wallet/subtract/:id', module: r18 },
];
