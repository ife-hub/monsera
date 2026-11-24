// lib/prisma.ts
import { PrismaClient } from '@prisma/client';

// Prevent creating multiple instances of PrismaClient during development
// because Next.js hot reloads can re-run modules
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

/**
 * Adds pool settings to DATABASE_URL without breaking URLs that already carry
 * query parameters (e.g. `?sslmode=require`). Existing values win.
 */
function withPoolParams(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '5');
    // Seconds a query waits for a free connection before failing (P2024).
    // Kept short so an overloaded app sheds load (503) instead of building
    // a backlog of requests whose callers have given up.
    if (!url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', '10');
    return url.toString();
  } catch {
    return raw;
  }
}

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Only override the datasource when a URL exists. At build time (e.g. the
    // Docker image build) DATABASE_URL is unset, and passing `undefined`
    // makes the PrismaClient constructor throw while Next collects page data.
    ...(process.env.DATABASE_URL && {
      datasources: { db: { url: withPoolParams(process.env.DATABASE_URL) } },
    }),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
