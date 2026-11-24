# db

The one Monsera database schema (`schema.prisma`) and all its migrations. Nothing else changes the schema.

```bash
npm ci
DATABASE_URL=postgresql://… npm run migrate:deploy   # apply (also: the Dockerfile, as a pre-deploy job)
DATABASE_URL=postgresql://… npm run migrate:dev      # create a new migration while developing
```

After changing `schema.prisma`, run `npm run schema:sync` at the repo root so every service gets the new copy, and commit both.
