#!/usr/bin/env node
/**
 * db/schema.prisma is the only schema. Each service that talks to the
 * database keeps a copy in <service>/prisma/schema.prisma so it can run
 * `prisma generate` on its own (and in its own Docker build).
 *
 *   node scripts/sync-schema.mjs           copy db/schema.prisma into every service
 *   node scripts/sync-schema.mjs --check   fail if any copy differs (CI)
 *
 * Migrations live only in db/migrations and run only from db/
 * (npm --prefix db run migrate:deploy). Services never run migrations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = ['monsera-payments', 'monsera-vend-ingestion', 'monsera-users-admin', 'monsera-admin', 'stress'];
const HEADER = '// GENERATED COPY of db/schema.prisma. Do not edit here: edit db/schema.prisma, then run `npm run schema:sync` at the repo root.\n';
const source = HEADER + fs.readFileSync(path.join(ROOT, 'db', 'schema.prisma'), 'utf8');
const check = process.argv.includes('--check');

let drift = 0;
for (const service of SERVICES) {
  const target = path.join(ROOT, service, 'prisma', 'schema.prisma');
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (current === source) continue;
  if (check) {
    console.error(`✗ ${service}/prisma/schema.prisma differs from db/schema.prisma`);
    drift++;
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    console.log(`updated ${service}/prisma/schema.prisma`);
  }
}
if (check && drift) {
  console.error('Run `npm run schema:sync` at the repo root and commit the result.');
  process.exit(1);
}
if (check) console.log('✓ every service schema matches db/schema.prisma');
