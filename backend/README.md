# PeachBot Backend

TypeScript service that replaces the n8n chat orchestration. Runs against the same
Supabase instance as the frontend, on an isolated `v3` Postgres schema so it can
live alongside the existing tables during cutover.

See `../../.claude/plans/act-as-a-principal-cozy-journal.md` for the full design.

## Setup

```bash
# from this directory (backend/)
npm install
cp .env.example .env.local
# fill in DATABASE_URL, GROK_API_KEY, PLATFORM_API_KEY, ACCOUNT_ID, REDIS_URL
```

Apply the v3 migration via Supabase CLI from the repo root:

```bash
supabase db push       # runs all pending migrations including 20260421120000_v3_schema.sql
```

Local Redis via Docker:

```bash
docker run -d --name peachbot-redis -p 6379:6379 redis:7-alpine
```

Generate typed DB client from the live schema (run once after each migration):

```bash
DATABASE_URL=... npm run db:types
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Watch-mode entry (`src/main.ts`) via tsx |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (one-shot) |
| `npm run db:types` | Regenerate `src/db/types.generated.ts` from live schema |

## Layout

```
src/
  config/            env loading + validation (zod)
  db/                Kysely client + types
  queue/             Redis connection, BullMQ queue/worker wiring
  observability/     logger
  main.ts            entry point
```

More folders arrive as phases ship (see the plan). Phase 0 lands foundations only —
no adapter, no workers yet.
