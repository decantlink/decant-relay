# decant-relay

The anonymous report relay for [Decant](https://decant.link). When a Decant user reports a link
that kept a tracker or broke after cleaning, the app sends a small report here. This repository is
the whole server, public so you can check what it accepts and stores.

> **We never receive your link, name or email, and never store your IP address.**

## What a report contains

Only what [`schema/report.schema.json`](schema/report.schema.json) allows, nothing else (any extra
field is rejected):

- the reasons for the report: `tracker-kept`, `link-broke` or both
- the host (for example `www.youtube.com`), never a path or full link
- every parameter of the link (at most 32): its name, the **shape** of its value (length and character
  class such as `digits` or `base64url`, never the value), what happened to it (`removed-by-rules`,
  `removed-by-you`, `kept` or `restored-by-you`) and whether the person flagged it (ticked it in the
  report as the one they mean)
- the generation number of the rule set the app used, so a report is read against the right rules
- the app's version (for example `1.4.2`) and build number, and the day
- a random report ID, so a retried send is stored once
- an optional note of up to 280 characters, sent exactly as the user typed it

`schemaVersion` is 1. The reasons (replacing a single kind) and the full app version and build (replacing the major
version) changed version 1 in place on 21 Nov 2026, before any released app sent a report. The parameter list above replaced the first draft's separate removed and kept lists
on 20 Nov 2026, before any released app sent a report.
## What is stored

One row per report: report ID, the day the relay received it (a date, no time), reasons, host, app
version and build, note, rules generation, and the parameters (name, shape, outcome, flagged). Nothing from the connection or the request
headers is read or stored; see [`src/index.ts`](src/index.ts) and [`src/store.ts`](src/store.ts).
Reports are summarised in a daily digest (see below). Raw reports are deleted after 180 days ([`src/retention.ts`](src/retention.ts)); counts per host,
parameter, reason and outcome (with how many were flagged) are kept, without report IDs or notes.

## What this does not prove

- The note is free text. Don't put anything private in it.
- A public repository cannot prove which version is deployed. The code, tests and configuration
  here are what the maintainers deploy.
- The relay runs on Cloudflare. As the network provider, Cloudflare handles connections to it under
  its own terms. The Worker's logging is turned off in [`wrangler.json`](wrangler.json) and a test
  checks that file.

## HTTP

`POST /v1/report` with `Content-Type: application/json`. Everything else answers 404 or 405.

| Status | Body | Meaning |
|---|---|---|
| 201 | `{"status":"accepted"}` | Stored, or already stored with the same report ID |
| 400 | `{"status":"rejected","reason":"…"}` | Not valid JSON, or off-schema; `reason` names a field, never a value |
| 413 | `{"status":"too-large"}` | Body over 16 KiB |
| 415 | `{"status":"unsupported-media-type"}` | Not `application/json` |
| 429 | `{"status":"capped"}` | The daily limit or the stored-reports ceiling is reached; try again later |
| 503 | `{"status":"paused"}` | The kill switch is on |

Abuse limits: a size cap, strict validation, a global daily cap (`DAILY_CAP`, default 5000 accepted
reports per day), a ceiling on stored raw reports (`MAX_RAW_REPORTS`, default 50,000, so
the free database cannot be filled), and one edge rate-limit rule configured in Cloudflare. The kill switch is a
`PAUSED` variable set in the Cloudflare dashboard, not in `wrangler.json` (`keep_vars` stops a deploy
from resetting it). Any value except unset, empty or `0` pauses the relay.

## Daily digest
After the nightly retention run, the Worker emails the maintainer a plain-text digest through
Cloudflare Email. It is sent only when there are new reports or a warning, plus a short check every Monday
(UTC) so a silent relay is noticeable. It covers whole UTC days since the last digest and contains:
- new reports, and how many for each reason (a report with both reasons counts under each)
- site and parameter pairs with 3 or more reports, pairs with flagged reports first, then newest, and
  "N reports from other sites" for the rest (it shows no flag counts)
- the age of the oldest stored report (a warning above 181 days means retention failed), how close the
  day's accepted count is to `DAILY_CAP` and the stored count to `MAX_RAW_REPORTS` (warnings at 80%), and
  whether the relay is paused
- a link to the D1 console

It never contains notes, report IDs or parameter values. The recipient and sender are the `DIGEST_TO` and
`DIGEST_FROM` variables, set in the Cloudflare dashboard like `PAUSED` (never in this repository). The
recipient must be a verified Email Routing destination and the sender an address on a domain onboarded to
Email Routing. Without the variables no email is sent. A failed send or retention run fails that cron run
and is retried the next night: the digest remembers only the last day it covered (`digest_state`).
## Triage
Read-only views of the reports, for the maintainer. No dashboard or web page exists.
```sh
npm run triage                              # production: the last 7 days
npm run triage -- --staging --since 2026-11-01
npm run triage -- --notes                   # adds the notes section, to the terminal only
```
It needs a Cloudflare login (`npx wrangler login`) and runs the SELECT statements below through
`wrangler d1 execute --remote`; it refuses anything that is not a SELECT. It shows the groups and counts, the
age of the oldest report, today's accepted count against `DAILY_CAP`, the stored count against
`MAX_RAW_REPORTS`, and whether the relay is paused (a text request that stores nothing).

**Notes are free text from users. Only the maintainer runs `--notes`, personally; AI agents never do**
(the default output has structured fields only, and may be run by anyone).

The same questions as saved queries for the Cloudflare D1 console (dashboard, D1, the database, Console).
Replace the date `2026-11-01` with the day to look back to:

**New reports, and by reason** (a report with both reasons counts under each)

```sql
SELECT COUNT(*) AS n FROM reports WHERE day >= '2026-11-01';
SELECT j.value AS reason, COUNT(*) AS n FROM reports r, json_each(r.reasons) j WHERE r.day >= '2026-11-01' GROUP BY j.value ORDER BY j.value;
```

**Site and parameter groups, flagged first, then newest**
```sql
WITH pairs AS (
  SELECT r.id AS id, r.day AS day, r.host AS host, json_extract(j.value, '$.name') AS param, MAX(json_extract(j.value, '$.flagged')) AS flagged
  FROM reports r, json_each(r.parameters) j WHERE r.day >= '2026-11-01'
  GROUP BY r.id, r.day, r.host, json_extract(j.value, '$.name')
)
SELECT host, param, COUNT(*) AS n, SUM(flagged) AS flagged, MAX(day) AS latest FROM pairs GROUP BY host, param ORDER BY SUM(flagged) DESC, MAX(id) DESC LIMIT 50;
```
**Parameter outcomes, and how many the person flagged**
```sql
SELECT json_extract(j.value, '$.outcome') AS outcome, COUNT(*) AS n, SUM(json_extract(j.value, '$.flagged')) AS flagged FROM reports r, json_each(r.parameters) j WHERE r.day >= '2026-11-01' GROUP BY outcome ORDER BY outcome;
```
**Reports by rules generation**
```sql
SELECT rules_generation, COUNT(*) AS n FROM reports WHERE day >= '2026-11-01' GROUP BY rules_generation ORDER BY rules_generation DESC;
```
**Age of the oldest raw report (retention failed if over 181 days)**

```sql
SELECT MIN(day) AS oldest FROM reports;
```

**Accepted today against DAILY_CAP**

```sql
SELECT date('now') AS day, COALESCE((SELECT n FROM daily_counter WHERE day = date('now')), 0) AS accepted;
```

**Stored raw reports against MAX_RAW_REPORTS**

```sql
SELECT COALESCE((SELECT n FROM raw_total WHERE id = 1), 0) AS raw_total;
```

**Notes (maintainer only; free text from users)**

```sql
SELECT day, reasons, host, note FROM reports WHERE note IS NOT NULL AND day >= '2026-11-01' ORDER BY id DESC LIMIT 50;
```

## Develop

```sh
npm ci
npm test            # schema + fixtures in Node, the Worker in a local workerd runtime
npm run typecheck
```

Client authors: test your payload builder against [`schema/fixtures/`](schema/fixtures/). Every file in
`valid/` and `edge/` must be accepted and every file in `invalid/` rejected.

## Deploy

Maintainers only. Create the D1 database, put its ID in `wrangler.json`, apply `migrations/`, then
`npm run deploy:staging`. Apply new migrations before deploying code that uses them. API tokens stay
in your environment, never in the repository.

For the digest: onboard the sending domain to Cloudflare Email Routing, verify the recipient address as a
destination, then set `DIGEST_TO` and `DIGEST_FROM` in the dashboard (Worker, Settings, Variables).

## License

MIT, see [LICENSE](LICENSE).
