// Generated from src/app/api by the port tooling. Each entry mounts one
// route handler module at its URL (see route-adapter.ts).
import type { RouteEntry } from './route-adapter';
import * as r0 from './app/api/partners/vends/route';
import * as r1 from './app/api/partners/vends/batch/route';

export const ROUTES: RouteEntry[] = [
  { path: '/api/partners/vends', module: r0 },
  { path: '/api/partners/vends/batch', module: r1 },
];
