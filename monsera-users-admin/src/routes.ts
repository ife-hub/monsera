// Generated from src/app/api by the port tooling. Each entry mounts one
// route handler module at its URL (see route-adapter.ts).
import type { RouteEntry } from './route-adapter';
import * as r0 from './app/api/auth/change-password/route';
import * as r1 from './app/api/auth/login/route';
import * as r2 from './app/api/auth/me/route';
import * as r3 from './app/api/user-types/route';
import * as r4 from './app/api/users/route';
import * as r5 from './app/api/users/[id]/route';

export const ROUTES: RouteEntry[] = [
  { path: '/api/auth/change-password', module: r0 },
  { path: '/api/auth/login', module: r1 },
  { path: '/api/auth/me', module: r2 },
  { path: '/api/user-types', module: r3 },
  { path: '/api/users', module: r4 },
  { path: '/api/users/:id', module: r5 },
];
