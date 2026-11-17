# decant-relay

The anonymous report relay for [Decant](https://decant.link). When a Decant user reports a link
that kept a tracker or broke after cleaning, the app sends a small report here. This repository is
the whole server, public so you can check what it accepts and stores.

> **We never receive your link, name or email, and never store your IP address.**

## What a report contains

Only what [`schema/report.schema.json`](schema/report.schema.json) allows, nothing else (any extra
field is rejected):

- the report kind: `tracker-kept` or `link-broke`
- the host (for example `www.youtube.com`), never a path or full link
- the names of the parameters the app removed and kept, and for each one the **shape** of its value
  (length and character class such as `digits` or `base64url`), never the value
- the app's major version and the day
- a random report ID, so a retried send is stored once
- an optional note of up to 280 characters, sent exactly as the user typed it

## What is stored

One row per report: report ID, the day the relay received it (a date, no time), kind, host, app
major version, note, and the parameter names and shapes. Nothing from the connection or the request
headers is read or stored; see [`src/index.ts`](src/index.ts) and [`src/store.ts`](src/store.ts).
Raw reports are deleted after 180 days ([`src/retention.ts`](src/retention.ts)); counts per host,
parameter and kind are kept, without report IDs or notes.

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
| 429 | `{"status":"capped"}` | The global daily limit is reached; try again later |
| 503 | `{"status":"paused"}` | The kill switch is on |

Abuse limits: a size cap, strict validation, a global daily cap (`DAILY_CAP`, default 5000 accepted
reports per day), and one edge rate-limit rule configured in Cloudflare. The kill switch is the
`PAUSED` variable (`1` pauses the relay).

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
`npm run deploy:staging`. API tokens stay in your environment, never in the repository.

## License

MIT, see [LICENSE](LICENSE).
