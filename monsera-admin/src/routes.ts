// Generated from src/app/api by the port tooling. Each entry mounts one
// route handler module at its URL (see route-adapter.ts).
import type { RouteEntry } from './route-adapter';
import * as r0 from './app/api/admin-type/route';
import * as r1 from './app/api/admin/flags/route';
import * as r2 from './app/api/aggregators/route';
import * as r3 from './app/api/aggregators/regenerate-api-key/route';
import * as r4 from './app/api/audits/route';
import * as r5 from './app/api/customer/route';
import * as r6 from './app/api/discos/route';
import * as r7 from './app/api/discos/regenerate-api-key/route';
import * as r8 from './app/api/employees/route';
import * as r9 from './app/api/finance/route';
import * as r10 from './app/api/loan-threshold/route';
import * as r11 from './app/api/meter-state/route';
import * as r12 from './app/api/roles/route';
import * as r13 from './app/api/system-admin/route';
import * as r14 from './app/api/aggregators/[id]/route';
import * as r15 from './app/api/audits/[id]/route';
import * as r16 from './app/api/customer/[id]/route';
import * as r17 from './app/api/discos/[id]/route';
import * as r18 from './app/api/employees/[id]/route';
import * as r19 from './app/api/finance/[id]/route';
import * as r20 from './app/api/loan-threshold/[id]/route';
import * as r21 from './app/api/meter-state/[id]/route';
import * as r22 from './app/api/roles/[id]/route';
import * as r23 from './app/api/system-admin/[id]/route';

export const ROUTES: RouteEntry[] = [
  { path: '/api/admin-type', module: r0 },
  { path: '/api/admin/flags', module: r1 },
  { path: '/api/aggregators', module: r2 },
  { path: '/api/aggregators/regenerate-api-key', module: r3 },
  { path: '/api/audits', module: r4 },
  { path: '/api/customer', module: r5 },
  { path: '/api/discos', module: r6 },
  { path: '/api/discos/regenerate-api-key', module: r7 },
  { path: '/api/employees', module: r8 },
  { path: '/api/finance', module: r9 },
  { path: '/api/loan-threshold', module: r10 },
  { path: '/api/meter-state', module: r11 },
  { path: '/api/roles', module: r12 },
  { path: '/api/system-admin', module: r13 },
  { path: '/api/aggregators/:id', module: r14 },
  { path: '/api/audits/:id', module: r15 },
  { path: '/api/customer/:id', module: r16 },
  { path: '/api/discos/:id', module: r17 },
  { path: '/api/employees/:id', module: r18 },
  { path: '/api/finance/:id', module: r19 },
  { path: '/api/loan-threshold/:id', module: r20 },
  { path: '/api/meter-state/:id', module: r21 },
  { path: '/api/roles/:id', module: r22 },
  { path: '/api/system-admin/:id', module: r23 },
];
