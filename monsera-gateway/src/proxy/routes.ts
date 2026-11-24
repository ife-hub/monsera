/**
 * Which service answers which /api path. Paths are the ones monsera-backend
 * served, so existing clients (frontend, APLE, discos) keep working.
 * First match wins; anything else under /api goes to monsera-admin.
 */
export type ServiceName = 'payments' | 'vend-ingestion' | 'users-admin' | 'admin';

export const SERVICE_URL_ENV: Record<ServiceName, string> = {
  payments: 'PAYMENTS_URL',
  'vend-ingestion': 'VEND_INGESTION_URL',
  'users-admin': 'USERS_ADMIN_URL',
  admin: 'ADMIN_URL',
};

const PREFIXES: Array<[string, ServiceName]> = [
  ['/api/transactions', 'payments'],
  ['/api/wallet', 'payments'],
  ['/api/float-ledger', 'payments'],
  ['/api/burn-rates', 'payments'],
  ['/api/cohort', 'payments'],
  ['/api/credit-parameters', 'payments'],
  ['/api/recovery-window-parameters', 'payments'],
  ['/api/obligations', 'payments'],
  ['/api/cron', 'payments'],
  ['/api/partners/vends', 'vend-ingestion'],
  ['/api/auth', 'users-admin'],
  ['/api/users', 'users-admin'],
  ['/api/user-types', 'users-admin'],
];

/** Paths that need no bearer token at the gateway (the service checks what it needs). */
const PUBLIC_PATHS = ['/api/auth/login', '/api/cron'];

function matches(path: string, prefix: string) {
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?');
}

export function serviceFor(path: string): ServiceName {
  for (const [prefix, service] of PREFIXES) if (matches(path, prefix)) return service;
  return 'admin';
}

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => matches(path, p));
}

/** Requests that move money get a longer upstream timeout (scoring alone may take 8s). */
export function timeoutFor(path: string): number {
  const base = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15_000);
  if (matches(path, '/api/transactions/debit') || matches(path, '/api/transactions/credit') || matches(path, '/api/cron')) {
    return Math.max(base, Number(process.env.MONEY_UPSTREAM_TIMEOUT_MS ?? 45_000));
  }
  return base;
}

export function serviceUrl(service: ServiceName): string {
  const url = process.env[SERVICE_URL_ENV[service]];
  if (!url) throw new Error(`${SERVICE_URL_ENV[service]} is not set`);
  return url.replace(/\/$/, '');
}
