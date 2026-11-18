# decant-relay — anonymous report relay for Decant

A Cloudflare Worker + D1 database that accepts shape-only reports about cleaned links and stores
them without the sender's IP address. It also owns the report schema and fixtures that clients
(the Decant apps, later browser extensions) test against.

## Structure

- `schema/report.schema.json` — the report contract (JSON Schema 2020-12, closed shape)
- `schema/fixtures/{valid,edge,invalid}/` — one payload per file; the filename says what it tests
- `src/validate.ts` — hand-written validator for the schema (cheap on the free plan's 10 ms CPU)
- `src/index.ts` — `POST /v1/report`, kill switch, size cap; `src/store.ts` — insert, dedupe, daily cap
- `src/retention.ts` — scheduled job: fold reports older than 180 days into counts, delete them
- `src/digest.ts` — daily digest email after retention (counts only; marker in `digest_state`)
- `scripts/triage.ts`, `scripts/triage-sql.ts` — read-only triage (`npm run triage`); the SQL is
  mirrored in the README's saved queries and a test keeps them equal
- `scripts/staging-seed.sql`, `scripts/staging-cleanup.sql` — synthetic rows for trying the digest on staging
- `migrations/` — D1 schema; `wrangler.json` — config, env `staging`; `test/` — vitest

## Commands

- `npm ci`, then `npm test` (schema tests in Node, Worker tests in the local workerd runtime)
- `npm run typecheck`
- `npm run triage` — read-only report views (production by default, `--staging`); needs a Cloudflare login
- `npm run deploy:staging` — maintainers only; needs a Cloudflare API token in the environment

## Conventions

- A schema change edits `report.schema.json`, `src/validate.ts` and the fixtures together; the
  tests run every fixture through both the schema (Ajv) and the validator and they must agree.
- Never read, store or log IP or header data. No `console.*` in `src/` (a test enforces it).
- `wrangler.json` keeps `observability.enabled=false`, `logpush=false`, no `tail_consumers`,
  `workers_dev=false` (a test enforces it). Cloudflare turns Workers Logs on by default.
- No secrets, account IDs, tokens or `.dev.vars` in the repo; secrets live in Cloudflare only. The
  digest addresses (`DIGEST_TO`, `DIGEST_FROM`) are dashboard variables, not in `wrangler.json`.
- Notes are users' free text. Only the maintainer runs `npm run triage -- --notes`, personally;
  agents never run it and never read production notes. Test with fixtures and seeded staging rows.
- The digest never contains notes, report IDs or parameter values; its input type has no field for them.
- Apply a new migration before deploying code that uses it; the digest otherwise fails its cron run.

## Contracts

- The report format is `schema/report.schema.json`; the HTTP behaviour is the table in `README.md`.

## Pointers

- `README.md` — the privacy promise, what is stored, HTTP responses, limits.

<!-- Update this file when the layout, commands or enforced conventions change. -->
