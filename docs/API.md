# Preshift API and the TeamPay integration

Preshift is API-first. The web app uses the same public API as any partner, EPOS, or client
system, so anything a screen can do, an integration can do. The OpenAPI document is served at
`/docs` (UI) and `/docs/json` (machine readable).

## Running

```bash
npm install
npm run dev        # API on :8787 and web app on :5173 (proxied)
npm test           # engine and API tests
```

With no TeamPay keys set, the API runs against the TeamPay simulator, so the whole flow works
locally. Set these to connect to real TeamPay:

| Variable | Purpose |
| --- | --- |
| `TEAMPAY_API_KEY` | Sandbox or production key from the TeamPay dashboard |
| `TEAMPAY_BASE_URL` | Defaults to `https://api.team-pay.co.uk/v1` |
| `TEAMPAY_EMPLOYER_ID` | The client's employer in TeamPay, for an organisation with one company only. A group sets an employer on each company instead (`PATCH /v1/entities/:id`); this variable is never used for more than one company. |
| `TEAMPAY_WEBHOOK_SECRET` | Signing secret for inbound webhooks |
| `PRESHIFT_API_KEYS` | JSON list of `{key, orgId, name, scopes}`. Outside production a `dev-key` exists. On Vercel there is no fallback key: with none set, only signed-in people reach the API (see `server/vercel.ts`) |
| `PRESHIFT_DATABASE_URL` | Neon Postgres connection string for Preshift's own database. On Vercel, if unset, the `DATABASE_URL` from the project's Neon integration is used; elsewhere a generic `DATABASE_URL` is ignored. Unset means in-memory storage. Preshift refuses any database that already holds another system's tables, and `/health` reports `database_not_dedicated` if so |
| `PRESHIFT_DEMO` | `1` makes the deployment the public demo: a sandbox per visitor at `/demo`, no account changes, simulator payroll. See the README |
| `PRESHIFT_DEMO_CLAUDE_KEY` | Demo only. Claude API key the sandboxes share for the rota assistant, capped per sandbox. Unset means the assistant is off in the demo |
| `PRESHIFT_DEMO_URL` | Live system only. Where its `/demo` sends visitors, the demo deployment's `/demo` |
| `CRON_SECRET` | Lets Vercel Cron call `/internal/dispatch` to retry undelivered payroll changes |

## Authentication and tenancy

People in the web app authenticate with the session cookie from signing in; accounts are managed
in the app under Settings (see the README). A signed-in person works across their own organisation,
and only admins can manage people (`/v1/users`) and settings (`/v1/settings`); integration keys never
can. Integrations use bearer API keys, each bound to one organisation with scopes: `rota:read`, `rota:write`,
`time:write`, `time:approve`, `payroll:write`, `hr:read`, `hr:write`, or `*`. A GM key can build rotas and approve
time but cannot send hours to payroll; that is a payroll or finance key. Every request is
confined to its key's organisation.

## Endpoints

| Area | Endpoints |
| --- | --- |
| Reference | `GET /v1/sites`, `/v1/roles`, `/v1/demand-rules` |
| Employees | `GET/POST /v1/employees`, `GET/PATCH /v1/employees/:id`, `POST /v1/employees/:id/leaver` |
| Right to work copies | `POST /v1/employees/:id/right-to-work/documents?fileName=` with the file as the raw body (PDF, JPEG, PNG or WebP, up to 4 MB; the type is read from the bytes, anything else is 415), `GET .../documents/:docId` to view, `DELETE .../documents/:docId` (signed-in admins only), `GET .../documents/:docId/access` (the copy's access log, signed-in admins only). Each copy is listed on the employee's `rightToWork.documents` with its SHA-256, who added it and when. Editing the employee never changes that list. |
| HR | `GET /v1/hr/overview?siteId=` (headcount, turnover, absence and every open personnel file check), `GET/POST /v1/hr/records`, `PATCH/DELETE /v1/hr/records/:id` (training, reviews, cases, documents, notes), `PUT /v1/employees/:id/hr` (contract, probation, NI number, emergency contact, line manager), `POST /v1/employees/:id/absences`, `PATCH/DELETE /v1/employees/:id/absences/:absenceId` (responses list rostered shifts the absence now clashes with). Needs `hr:read` or `hr:write`. A key without them gets employees with no `hr` file and absences reduced to `{id, type, from, to}`. Cases are returned to signed-in admins only, never to members. |
| Shifts | `GET/POST /v1/shifts`, `PATCH/DELETE /v1/shifts/:id` (responses carry compliance issues) |
| Rota | `GET /v1/rota/week`, `POST /v1/rota/build`, `/clear`, `/publish` (publish refuses blocking breaches) |
| Forecast | `GET/PUT /v1/forecast` (Preshift Reports pushes hourly sales and covers here) |
| Takings | `GET/PUT/DELETE /v1/sales` (a till or EPOS integration pushes each day's net takings per site; `PUT` adds or replaces by site and day, `DELETE ?siteId&date` removes one so reports fall back to the forecast) |
| Time | `POST /v1/time-entries/clock-in`, `/:id/clock-out`, manual `POST /v1/time-entries`, `PATCH`, `POST /approve` (returns `belowBreakMinimum`, recorded in the audit), `GET /compare`, `GET /break-check` (finished shifts below the legal rest break: `short` or `split`) |
| Clocking | `PUT`/`DELETE /v1/sites/:id/geofence`, `PUT`/`DELETE /v1/employees/:id/badge`, `POST /v1/time-entries/tap` (RFID card: clocks in, or out if already in). Device clock-in and clock-out take `location: {lat, lng, accuracyMetres}`; a fenced site refuses one missing or outside the fence (`location_required`, `outside_site`, `too_imprecise`). The fix's accuracy is allowed on top of the radius, up to the radius again, and fixes worse than 250 m are refused. Card taps are not location checked, as the reader is fixed on site. |
| Staff app | Managers: `GET /v1/staff-logins`, `POST /v1/staff-logins/:employeeId/invite` (returns a one-time link, valid 7 days), `DELETE /v1/staff-logins/:employeeId`. Staff, with their own `ps_staff` session (30 days, signed with a key derived for staff only, so it is never accepted by the manager API): `GET /v1/staff/invite`, `POST /v1/staff/join`, `/login`, `/logout`, `GET /v1/staff/me`, `POST /v1/staff/clock-in`, `/clock-out`, `/break-start`, `/break-end`. Recorded breaks are kept on the entry as `breaks: [{start, end}]` and set `breakMinutes` at clock-out; clocking out ends a running break. A card tap on `/v1/time-entries/tap` while on a break returns `break_end`. Five wrong passwords lock the login for 15 minutes. Phone clocking is refused at a site with no geofence (`site_not_set_up`). |
| Travel | `PUT /v1/sites/:id/location` (`{postcode}`, looked up on postcodes.io, or `{lat, lng}`; clears looked-up journeys to and from the site), `POST /v1/sites/travel/refresh` (TfL journey planner for every pair of located sites, each way, weekday 17:00, public transport or walking; hand-set times kept; a labelled straight-line estimate where TfL has no answer), `PUT`/`DELETE /v1/sites/:id/travel/:toId` (`{minutes}` set by hand, both ways). Journeys are kept on each site as `travel: {siteId: {minutes, source: tfl\|estimate\|manual, mode, checkedAt}}`. Shift responses carry `travel` (blocking: cannot get there in time), `travel-tight` and `travel-unknown` issues. A same-day journey between sites is paid working time: costs, journals and payroll submissions include it, charged to the shift travelled to, and payroll hours lines carry `travelHours` (already inside `hours`). `TFL_APP_KEY` is optional; the planner works without one at low volume. |
| Payroll | `GET /v1/integrations/payroll` (overall and per PAYE scheme), `POST /sync-employees`, `GET /outbox`, `POST /outbox/:id/retry`, `POST/GET /v1/payroll/submissions` (one batch per company; `entityId` for one company), `GET /v1/payroll/runs`, `PATCH /v1/entities/:id` (a company's TeamPay employer and PAYE reference) |
| Finance | `GET /v1/journal?weekStart=&basis=rota\|actual\|auto&format=json\|xero-csv` |
| Inbound | `POST /v1/integrations/teampay/webhook/:orgId` (HMAC signed, no API key) |

## How payroll stays truly integrated

```
 Rota ──> Clock in/out ──> Manager approval ──> Hours batch ──> Outbox ──> TeamPay
                                                     │                       │
                                       Labour accrual (journal)     Pay run completes
                                                     │                       │
                                                     └──── Variance <────────┘ (signed webhook)
```

1. One person record. Starters, changes to pay fields and leavers are queued for TeamPay at
   the moment they are saved. TeamPay returns its employee id, which Preshift stores.
2. Payroll is paid from approved clocked time, never from the rota. Unapproved time blocks
   the submission.
3. Every change goes through an outbox with an idempotency key. If TeamPay is down, the change
   waits and retries with backoff (up to 8 attempts); it is never lost and never sent twice.
   Failures stay visible with a retry button.
4. A sent period locks. A correction is a new versioned submission that supersedes the last.
5. When TeamPay completes the run it sends `payroll.run.completed`. Preshift fetches the run
   and reports the variance between what was accrued and what payroll cost, per person.
6. Tronc stays in TeamPay Tronc and allocates from the same hours TeamPay receives.

## One payroll per PAYE scheme

Each company in a group is its own employer with its own PAYE scheme, so each has its own
TeamPay employer and runs its own payroll. Every call to TeamPay names the employer it is for.

- A person is set up, changed and made a leaver under the employer of the company that employs
  them, wherever they work. The employer is recorded against them once set up, and a later
  leaver goes to that same scheme.
- Hours are sent as one batch per company, holding only that company's people (including hours
  they worked at a sister company's site). Each batch has its own version and idempotency key,
  and resending one company supersedes only that company's batch.
- Sending is all or nothing: if any company with hours has no TeamPay employer, nothing is sent
  (409 `payroll_employer_missing`). Starters for such a company fail in the outbox with the
  reason, and go through on retry once the employer is set.
- A pay run webhook carries `employer_id`. Preshift matches it to the company and compares the
  run with that company's accrual only. A run for an employer no company is set up as is refused
  (422) and not marked processed, so TeamPay's retry succeeds once it is set.
- Moving a person who is already in payroll to another company is refused (409
  `scheme_transfer`): in law it is a leaver from one scheme, with a P45, and a starter in the
  other. Pointing a company at a different employer once its people are set up is refused for the
  same reason (409 `employer_has_people`), and two companies cannot share one employer.
- An organisation with one company keeps working on `TEAMPAY_EMPLOYER_ID` as before.

## What must be confirmed with the TeamPay API reference

The TeamPay client (`server/integrations/payroll/teampay.ts`) is the only file that knows
TeamPay's paths and field names. It follows what TeamPay publishes (REST, push hours and
starters, pull pay runs, `payroll.run.completed` webhooks, sandbox keys), but these details are
assumptions until checked against the API reference:

- Paths: `POST /employees`, `PATCH /employees/:id`, `POST /employees/:id/leaver`, `POST /hours`, `GET /pay-runs/:id`.
- Field names (snake case), and whether cost centre and role are accepted on hours lines.
- That one API key can act for several employers by naming one per call, and that the
  `payroll.run.completed` webhook says which employer the run is for (`employer_id`).
- Header names for the employer (`x-teampay-employer`), idempotency (`idempotency-key`) and the
  webhook signature (`x-teampay-signature: sha256=<hex HMAC of the raw body>`).
- How TeamPay treats a resubmitted hours batch for the same period (replace or add).
- Pay schedules other than weekly. Preshift periods are weekly in this build.

Because WS runs TeamPay, these can be settled in one working session. Change that file, run
`npm test`, and the rest of the system is unaffected.

## Storage

Each request loads one organisation, works on it, and saves it once, only if the request
succeeded. Saves use optimistic locking: if two requests change the same organisation at once,
the second is refused with 409 instead of overwriting the first. Payroll changes are queued in
the same save as the change that caused them, so a starter or a batch of hours is never saved
without its delivery to TeamPay also being recorded.

`PgStore` keeps each organisation as one JSONB document in its own `preshift` schema, using
Neon's HTTPS driver (works from serverless functions). Tests run the same code on PGlite.

Uploaded files (right to work copies) are kept in `preshift.documents`, one row per file, never
inside the organisation document, so loading the rota never carries passport scans. The
organisation document holds only each file's name, size, hash and who added it. A file written
by a request whose save then fails is removed again, and a deleted file is only removed once the
record no longer names it.

Every file is encrypted with AES-256-GCM under `PRESHIFT_DOCUMENT_KEY`, a key held in the
deployment's environment and never in the database, so a copy of the database alone yields no
documents. The organisation and file id are bound into each file, so a file moved to another
record or altered fails to decrypt and is not shown. Generate the key with
`openssl rand -base64 32` and keep a copy somewhere safe: files cannot be read without it. With a
database and no valid key, uploads and views are refused (503 `document_key_missing`), and
`/health` reports `documents: "no key"` or `"invalid key"`. The in-memory demo uses a throwaway key.

Every addition, view and deletion of a file is written to `preshift.document_access`, an
append-only table that keeps the entry after the file is deleted: who (email or API key name),
how (signed in or integration), when, and from which IP address. A view is logged before the file
is sent; if the log cannot be written, the file is not shown.

## Deployment (Vercel)

`npm run build:vercel` writes one deployment using Vercel's Build Output API:

| Path | Served by |
| --- | --- |
| `/` | Marketing site (`site/`) |
| `/app` | Rota web app |
| `/v1/*`, `/docs`, `/health` | The API, as one Node function |
| `/internal/dispatch` | Daily Vercel Cron retry of undelivered payroll changes (needs `CRON_SECRET`) |

Payroll changes are also delivered inside the request that makes them, so the cron is a safety
net, not the main path.

## Before real client data

- Give Preshift its own Neon project and set `PRESHIFT_DATABASE_URL`. Do not share a database
  with the WS operations platform: the JV is a separate controller of its client data.
- Per-organisation TeamPay credentials (the code already resolves the provider per org).
- Staff authentication for the mobile app (clocking) alongside API keys for systems.
- Split the JSONB document into tables when cross-organisation reporting needs SQL.
- Set `PRESHIFT_DOCUMENT_KEY` before anyone uploads a right to work copy, and store it outside
  Vercel as well. Losing it loses every stored copy.
