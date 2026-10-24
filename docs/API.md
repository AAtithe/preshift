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
| `PRESHIFT_API_KEYS` | JSON list of `{key, orgId, name, scopes, userId?}`. Outside production a `dev-key` (acting as the demo owner) and a `dev-<userId>` key per demo person exist. On Vercel there is no fallback key: with none set, only signed-in people reach the API (see `server/vercel.ts`) |
| `PRESHIFT_PUBLIC_URL` | Optional. The address people reach Preshift on, for example `https://rota.example.co.uk`, used as the issuer for Sign in with Preshift. Set it only behind a proxy that changes the host name |
| `PRESHIFT_SECRET_KEY` | Optional, 64 hex characters. Encrypts authenticator secrets (AES-256-GCM) with a key that never sits in the database. Without it a key is made once and kept in the settings table; outside a deployment a fixed development key is used. Never change it once people have enrolled |
| `PRESHIFT_DATABASE_URL` | Neon Postgres connection string for Preshift's own database. On Vercel, if unset, the `DATABASE_URL` from the project's Neon integration is used; elsewhere a generic `DATABASE_URL` is ignored. Unset means in-memory storage. Preshift refuses any database that already holds another system's tables, and `/health` reports `database_not_dedicated` if so |
| `PRESHIFT_DEMO` | `1` switches on the public demo alongside customers: a private sandbox per visitor from `/demo`, on a route allowlist, simulator payroll, wiped at midnight UK time. Unset is the kill switch. See the README |
| `PRESHIFT_DEMO_CLAUDE_KEY` | Claude API key the demo sandboxes share for the rota assistant, capped per sandbox and per day. Never a customer's key. Unset means the assistant is off in the demo |
| `PRESHIFT_PUSH_CONTACT` | Optional. The `mailto:` or `https:` contact push services are given with each staff app notification (VAPID). Defaults to `mailto:support@preshift.co.uk`. The VAPID key pair itself is made on first use and kept in the database |
| `PRESHIFT_SIGNUP` | `1` switches on self sign-up: "Start a free trial" on the sign-in page. Needs email set up under Settings in the first organisation, which sends the confirmation links. Unset is the kill switch; organisations already made carry on |
| `PRESHIFT_TRIAL_DAYS` | Free trial for a self sign-up, in days. Defaults to 14 |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...` or `sk_test_...`). Billing is on only when this, the webhook secret and the price are all set |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_...`) of the Stripe webhook pointed at `/v1/integrations/stripe/webhook`, sending `checkout.session.completed`, `customer.subscription.created`, `.updated`, `.deleted`, `invoice.paid` and `invoice.payment_failed` |
| `STRIPE_PRICE_ID` | The monthly Stripe price, graduated per site from `src/engine/pricing.ts`. Make it with `npm run stripe:prices`, which prints the value. The subscription's quantity is the organisation's site count |
| `STRIPE_PRICE_ID_ANNUAL` | The yearly price made by the same script (two months free). Without it only monthly billing is offered |
| `PRESHIFT_APP_URL` | Optional. The address Stripe returns people to after Checkout and the customer portal; defaults to the address they came in on |
| `XERO_CLIENT_ID` | The Preshift app's client id from the Xero developer portal (a Web app). With the secret set, settings people can connect Xero on Close; without them only the simulated Xero is offered, in the demo and development |
| `XERO_CLIENT_SECRET` | The app's client secret |
| `XERO_REDIRECT_URI` | Optional. Where Xero returns people: must match the redirect URI registered on the app exactly. Defaults to `PRESHIFT_APP_URL` followed by `/v1/integrations/xero/callback`, so one of the two must be set |
| `XERO_SCOPES` | Optional. Defaults to `openid profile email offline_access accounting.transactions accounting.settings.read`. An app created under Xero's granular scopes sets the equivalents for manual journals, accounts and tracking |
| `CRON_SECRET` | Lets Vercel Cron call `/internal/dispatch` (daily, undelivered payroll changes), `/internal/webhooks` (every 15 minutes, webhook retries) `/internal/demo-reset` (the demo's midnight reset) and `/internal/digest` (06:35 UTC, the managers' morning email of staff requests) |

## Authentication and tenancy

People in the web app authenticate with the session cookie from signing in (see the README). A
session is matched by email to the person's access record in their organisation, and their roles
then decide (below). A session with no access record keeps full access to its organisation, as every
account had before roles, and the Access overview lists it as a finding until it is given a record.
People and access (`/v1/users`, `/v1/access/*`) are managed by people only, never by an integration
key; settings (`/v1/settings`) need a signed-in person with `settings.manage`, and staff data
requests (`/v1/privacy/*` beyond the register) a person with `privacy.manage`. Personnel files
(`/v1/hr/*`) need `hr.view` or `hr.manage` where the person works, and cases `hr.cases`. Integrations use bearer API keys, each bound to one organisation with scopes (see Plugging in,
below). Programme sign-offs, baselines, verifications and the gain share set the fee an operator
pays, so they need the `programme.lead` permission, which only the WS client partner role carries,
or a deployment key Williams, Stanley & Co. holds with the `programme:lead` scope. That scope is never
implied by `*` and cannot be given to a key made in the app. WS roles are granted only by the WS
client partner or by that key, which may also invite the first partner (`POST /v1/users` with
`audience: "ws"`) and is refused any operator role; the operator's owner, and a sign-in with no access
record, can remove WS people but never appoint or change them. A GM key can build rotas and approve
time but cannot send hours to payroll; that is a payroll or finance key. Every request is
confined to its key's organisation.

A key with a `userId` is a personal key: on every route it acts as that person, as a session does, so their key's
scopes and their roles must both allow it, at the site in question (`server/guard.ts`). A key
without one is a system key with organisation-wide authority. The web app uses a personal key;
outside production each seeded person has one (`dev-<userId>`) and the demo can sign in as any of them.

| Route | Needs, at the site |
| --- | --- |
| Sites, shifts, demand rules, forecast, staff list | `rota.view` (staff: or `team.manage`). Lists are trimmed to those sites |
| Shift changes, build, clear | `rota.edit` (a moved shift, at both sites) |
| Publish | `rota.publish` |
| Rest breach overrides: record, withdraw | `rota.publish` where the short rest is worked, and a person: never a system key. Listing them needs `rota.view` |
| Forecast upload, forecast from takings | `demand.manage` at every site in the upload or the build |
| Rota week's cost, staff pay rates | `costs.view` or `pay.edit`; otherwise `metrics` is null and pay reads nought with `payHidden`. A key also needs `employees:read` for cost by person and by shift |
| Starters, changes, leavers | `team.manage`; a rate, salary or pay basis also `pay.edit`, never on your own record. From a person this proposes the change (the response carries `pendingPay`) rather than applying it |
| Pay changes | `GET /v1/pay-changes` (`pay.edit` or `pay.approve` at the site; a key also needs `employees:read`). It is the whole pay history: pay set without approval is listed too, with `direct: system` (a deployment's own key) or `direct: no_approver` (nobody else holds `pay.approve`). A waiting change carries `standing: {dueBy, standing: on_time\|due_today\|overdue, cutoff, daysToCutoff}`. `POST /v1/employees/:id/pay-changes` (`pay.edit`) takes an optional `effectiveFrom`, within a year either side of today and not before the start date: approved before it, the change waits (`approved` with no `appliedOn`) and the daily run applies it on the day; approved after it, it applies at once with `backPay: {from, to, hours, amount, basis: clocked\|rota\|salary}` for the work in between, which goes to payroll as an adjustment with the next hours sent. A person with a change approved and still to take effect cannot be given another (`409 scheduled`). `POST /v1/pay-changes/:id/approve` and `/reject` (`pay.approve`, never on your own proposal or pay; reject needs a `note`), `/withdraw` (`pay.edit` for a waiting change, `pay.approve` for an approved one still to take effect). Approval answers `409 stale` if the pay in force moved since the proposal; a dated change whose starting pay moved before its day is marked `superseded`, not applied |
| Pay approval rule | `GET /v1/pay-policy` (`pay.edit` or `pay.approve` anywhere): `{policy: {turnaroundDays, cutoffWeekday}, nextCutoff, approvers: [{id, name, ready}], canApprove}`. `ready` is false for an approver without an authenticator; `canApprove` is false when nobody is ready. `PUT /v1/pay-policy` (`pay.approve` or `settings.manage`): turnaround 1 to 10 working days (weekends and England and Wales bank holidays skipped), cutoff weekday 0 (Monday) to 6. `POST /v1/pay-changes/remind` (a person) sends now what the daily run sends each morning: an email to each approver with counts and dates, never names or rates, copying the owner in once a change is overdue or the cut-off is today or tomorrow |
| Rostering another site's person | `rota.edit` at the shift's site, and either their agreement to cover it or `rota.edit` or `team.manage` at their home site (`403 not_cover`) |
| Clocking, card taps, manual entries, edits | `time.record` |
| Site clocking area (geofence) | `settings.manage`: a wider fence lets people clock in from elsewhere |
| RFID cards | `team.manage` at the person's home site |
| Time entries and rota against clock | `time.record`, `time.approve` or `payroll.view` |
| Approval | `time.approve`; your own hours are skipped by range (`ownSkipped`) and refused by id |
| Payroll status, submissions, runs, outbox | `payroll.view` |
| Sync, send hours, retry | `payroll.send` |
| A company's TeamPay employer and PAYE reference | `settings.manage`: it decides where that company's hours are sent |
| A company's pay premiums | `pay.approve`: a premium raises the pay of everyone it touches, so it sits with whoever approves pay |
| Labour accrual journal | `close.export` |

## Plugging in: API keys

The API is open to any system a customer wants to connect: an EPOS pushing sales, a BI tool reading
labour, an in-house app, a partner product. Nobody at Preshift has to issue anything.

1. A person signed in with `settings.manage` (which needs their authenticator) opens Settings,
   API keys, names the key after the system that will use it and ticks what it may do. Each scope
   needs the matching permission held across the whole organisation, so nobody can make a key that
   does more than they can: `rota:read` needs `rota.view`, `employees:read` `costs.view`, `rota:write`
   `rota.edit`, `time:write` `time.record`, `time:approve` `time.approve`, `payroll:write`
   `payroll.send`, `hr:read` `hr.view`, `hr:write` `hr.manage`, `webhooks:write` `settings.manage`
   (refused as 403 `beyond_own_access`). The Owner role holds neither `payroll.send` nor
   `time.approve`, as paired duties, so it cannot make a key that sends payroll or approves hours.
   Keys made here are organisation-wide system keys, recorded against the person who made them, and they answer to that
   person: the audit names them (`API key Tevalis EPOS, made by Olivia Grant`), a pay rate sent with the key is proposed to
   finance like the maker's own (never set, and never the maker's own pay or staff record), a key never approves or
   rejects pay, and a key never sees or records a case. Only a deployment's own key, set in its environment, sets pay directly. The key (`psk_...`) is shown once. Only its SHA-256 is stored, in its own table,
   so no data endpoint can return it and a database leak gives nobody a working key.
2. The system sends `Authorization: Bearer psk_...` on every request. It reaches that organisation
   only, and only the scopes ticked. A key can never make, list or revoke keys, or manage people
   or settings: that needs a person signed in.
3. Revoking a key under Settings stops it on the next request. Each key shows when it was last used,
   so keys nobody uses any more are easy to find and remove.
4. Every call made with a key is recorded: time, method, path and query, status, caller address and
   response time, written before the response leaves so the log has no gaps. Refused calls are
   recorded too, marked `revoked` or `rate_limited`. Revoking keeps the key's record, so an attempt
   to use a leaked key after revocation is refused, logged against it and visible in its log.
   People with `settings.manage` see each key's last 200 calls under Settings, API keys, Calls, and
   download up to 1,000 as CSV from `GET /v1/api-keys/:id/calls?from=&to=&limit=&format=csv`
   (deployment keys as `env:<name>`); each download is written to the audit trail. Calls are kept
   396 days (the partner addendum's 12 months plus a month) and purged by the daily run. Requests
   from people signed in to the app are in the audit trail instead.

Staff records and pay sit behind `employees:read`, apart from `rota:read`, so a BI tool or EPOS can
read labour totals without seeing anyone's date of birth, rate or pay. Without it, `/v1/rota/week`
still returns total labour cost but leaves cost by person and by shift empty, and time entries come
without clock locations. Grant it only to systems that hold staff records themselves (HR, payroll).
Keys in `PRESHIFT_API_KEYS` that have `rota:read` are given `employees:read` too, because they had
it before the split.

Each key may make 300 requests a minute (`x-ratelimit-*` headers; `429` with `retry-after` beyond
that). The limit is held per server instance, so it guards against a runaway loop rather than
acting as a billing quota. Keys from `PRESHIFT_API_KEYS` still work, for keys set by deployment.

| Scope | Allows |
| --- | --- |
| `rota:read` | Read sites, roles, shifts, forecast, labour totals, clocked hours, payroll status and journals |
| `employees:read` | Read staff records and pay: `/v1/employees`, cost by person and by shift in `/v1/rota/week`, clock locations on time entries, payroll submissions, pay runs and the payroll outbox |
| `rota:write` | Change shifts and people, build and publish rotas, load the forecast |
| `time:write` | Clock in and out, enter or edit time |
| `time:approve` | Approve clocked time for payroll |
| `payroll:write` | Send people and approved hours to payroll |
| `hr:read` | Read personnel files, absence reasons and the HR overview (see HR below). Includes `employees:read` |
| `hr:write` | Change personnel files and record absence. Includes `hr:read` reads and `employees:read` |
| `webhooks:write` | Register and remove webhook endpoints |
| `*` | All of the above |

## Plugging in: webhooks

Polling tells a partner too late. Webhooks tell it the moment something changes.

- Register an https endpoint and the events it wants under Settings, Webhooks (a person with
  `settings.manage`), or with `POST /v1/webhooks` from a system key with `webhooks:write`. A
  personal key needs both the scope and its person's `settings.manage`. The signing secret (`whsec_...`) is
  returned once. `GET /v1/webhooks/events` lists every event and what its data holds.
- Each event is a POST of `{id, type, createdAt, orgId, data}` with headers `preshift-event-id`,
  `preshift-event-type` and `preshift-signature: t=<unix seconds>,v1=<hex>`, where `v1` is the
  HMAC-SHA256 of `<t>.<raw body>` with the secret. Check the signature, refuse a `t` more than five
  minutes old, and treat `id` as the idempotency key: an event can arrive twice.
- Events are thin. They carry what changed and its ids (`data.id`, `data.siteIds`, field names),
  never pay, dates of birth or other personal data. The receiver fetches the detail with its key,
  so what it can see is still governed by that key's scopes.
- Events are raised from the audit trail, in the same save as the change, so one is never sent for
  a change that failed and never lost for one that was saved. They are sent inside the request
  that raised them (three second timeout, endpoints in parallel), and anything not answered 2xx
  is retried with backoff up to eight times, on the organisation's next change or the 15 minute
  cron, whichever comes first, so a partner that was down hears within a quarter of an hour of its
  next retry falling due. An endpoint's events go in order; a failing one holds back only its own.
- HR events (`hr.profile.updated`, `hr.absence.*`, `hr.record.*`, `employee.rtw_document.*`) say
  something about a named person's health, conduct or immigration status, even as bare ids, so:
  they are never part of `*` and an endpoint names each one; only a person with `hr.view` across the
  whole organisation, or a key with `hr:read` (a personal key needs both), can subscribe to them, or
  move or re-key an endpoint that carries them; they never carry an absence's type, reason or dates,
  a file name or a document hash; and disciplinary, grievance and capability cases (`kind: case`)
  are never sent at all, as only people with `hr.cases` see them.
- Settings shows events not yet delivered, with the error and a Retry now button. Send test
  posts a `webhook.test` event and reports what the endpoint answered.
- Addresses must be public https. Private, link-local and cloud metadata addresses are refused, so
  a webhook cannot be used to reach Preshift's own network. `http://localhost` is allowed outside
  production for building a receiver on a laptop.
- The public demo refuses keys and webhooks (anyone could otherwise make Preshift call any
  address); its API docs stay open.

Webhook endpoints: `GET /v1/webhooks/events`, `GET/POST /v1/webhooks`, `PATCH/DELETE /v1/webhooks/:id`,
`POST /v1/webhooks/:id/test`, `POST /v1/webhooks/:id/rotate-secret`, `GET /v1/webhooks/deliveries`,
`POST /v1/webhooks/deliveries/:id/retry`.

## Plugging in: Claude and other MCP clients

Preshift is also an MCP (Model Context Protocol) server, so Claude, or any assistant that speaks
MCP, can read the rota, cost and compliance and run the week in plain English: "what is labour
at Marylebone next week against target", "build the group for the 26th and tell me what will
not publish", "approve Friday's clocked time at the bar".

- The connector is `POST /mcp` on the same server (Streamable HTTP, stateless, JSON responses).
  There is no event stream, so `GET /mcp` answers 405. Protocol versions `2025-06-18`,
  `2025-03-26` and `2024-11-05` are accepted.
- It authenticates exactly as the API does: `Authorization: Bearer psk_...`, a key made under
  Settings, API keys. Make one key per assistant, named after it ("Claude, finance team"), with
  only the scopes it needs. A key with `rota:read` alone gives a read-only connector that can
  never change the rota.
- Every tool is a call to a `/v1` route made with the caller's own key. The connector adds no
  authority: scopes, site access, paired duties, compliance blocks, the audit trail and webhooks
  apply exactly as they would to the same key calling the API. `tools/list` shows only the tools
  the key may run, each marked read-only or not, and removing a shift is marked destructive so a
  client asks before it runs.
- A refusal comes back as the tool's result with Preshift's reason (a compliance block, a missing
  permission), so the model can put it right rather than fail. An unknown tool or method is a
  JSON-RPC error.
- Each tool call is two requests against the key's 300 a minute: one to `/mcp`, one to the API.
- A request carrying an `Origin` header from another site is refused, so a web page cannot drive
  the connector with a signed-in person's cookie.

| Tool | Scope | Calls |
| --- | --- | --- |
| `list_sites` | `rota:read` | `GET /v1/sites` |
| `list_roles` | `rota:read` | `GET /v1/roles` |
| `list_employees` | `employees:read` | `GET /v1/employees` |
| `get_rota_week` | `rota:read` | `GET /v1/rota/week` |
| `list_shifts` | `rota:read` | `GET /v1/shifts` |
| `get_forecast` | `rota:read` | `GET /v1/forecast` |
| `get_sales` | `rota:read` | `GET /v1/sales` |
| `list_time_entries` | `rota:read` | `GET /v1/time-entries` |
| `compare_rota_to_clocked` | `rota:read` | `GET /v1/time-entries/compare` |
| `get_labour_journal` | `rota:read` | `GET /v1/journal` |
| `list_payroll_runs` | `employees:read` | `GET /v1/payroll/runs` |
| `build_rota` | `rota:write` | `POST /v1/rota/build` |
| `add_shift` | `rota:write` | `POST /v1/shifts` |
| `remove_shift` | `rota:write` | `DELETE /v1/shifts/:id` |
| `publish_rota` | `rota:write` | `POST /v1/rota/publish` |
| `approve_time` | `time:approve` | `POST /v1/time-entries/approve` |

Connecting Claude with a key, in Claude Code:

```bash
claude mcp add --transport http preshift https://<your Preshift address>/mcp \
  --header "Authorization: Bearer psk_..."
```

### Sign in with Preshift (claude.ai)

claude.ai connects with no key at all. Add a custom connector (Settings, Connectors) with the
address `https://<your Preshift address>/mcp` and press Connect. Claude finds Preshift's sign-in
on its own, opens it, and the person signs in to Preshift as they normally do. They then see
what Claude will be able to do and tick the boxes, and Claude is connected. Claude Code and
Claude Desktop use the same sign-in when added without a key header.

- Standards: OAuth 2.1 with PKCE (S256 only), dynamic client registration (RFC 7591),
  protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`,
  authorisation server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`, and
  token revocation (RFC 7009) at `/oauth/revoke`. A `401` from `/mcp` names the metadata in
  `WWW-Authenticate`, which is how a client finds the sign-in.
- A token acts as the person who approved it, exactly as a personal API key does. Their roles
  decide, site by site: a GM's connection reaches their own site only. It never counts as having
  passed the authenticator, so strong rights (pay changes and approval, payroll, settings, access,
  HR cases, close export) stay in the app, whatever the person holds.
- The person ticks what Claude may do from `rota:read` (ticked by default), `employees:read`,
  `rota:write` and `time:approve`. Nothing else is offered.
- Only someone with an active access record in the organisation can connect. The public demo
  refuses.
- Access tokens last an hour; refresh tokens 30 days and rotate on every use. A refresh token
  used twice ends the whole connection, as it means someone holds a copy. Codes last five
  minutes and work once, with their own verifier, for their own app and address.
- A connection ends at once when the person disconnects it at `/oauth/connections`, when it is
  revoked, when the person is removed or suspended, or when their password is reset.
- Redirect addresses must be https, or http on `localhost` for desktop clients, and must match
  what the app registered exactly. A bad one is shown as an error, never followed.
- Every connection and disconnection is in the organisation's audit trail (`oauth.connected`,
  `oauth.revoked`). Calls made through it are logged like any key's, as `oauth:<grant id>`.
- Clients, codes and tokens are kept in the settings table, hashed, so nothing new needs setting
  up. Set `PRESHIFT_PUBLIC_URL` if Preshift sits behind a proxy that changes the host name;
  otherwise the address is taken from the request.

Locally, `npm run dev` serves it at `http://localhost:8787/mcp` with `dev-key`. Add a tool in
`server/mcp.ts`: name the route it calls and the scope it needs; the route does the rest.

## Users and access

The model follows Signal. A user record grants nothing. Access comes from memberships: a role,
for the whole organisation or named sites, live between a start and an optional end date. The
rules live in `src/engine/access.ts`, which the API enforces and the browser runs for live feedback.

| Rule | Effect |
| --- | --- |
| No granting beyond your own | You can only grant permissions you hold where you grant them. The Owner and the WS client partner may appoint to their side without holding each duty, so the Owner can appoint a payroll manager without sending pay. |
| Site managers | A GM or area manager grants site roles at their own sites only, and sees only the people at those sites. |
| Sides | Operator roles are granted by the operator, WS roles by the WS client partner, outside roles always carry an end date. |
| Paired duties | Checked across every role a person holds. Pay rates with sending payroll is refused. Proposing pay with approving it needs an accepted reason, and approving your own proposal is refused regardless. Starters with payroll, approving hours with pay rates, and access management with payroll need an accepted reason, which is kept on the grant. |
| Authenticator | Pay, payroll, locking, the journal, settings and access management stay off for a role that requires an authenticator until the session has entered a code from it. The session cookie then names the enrolment it proved, so a reset or a new enrolment ends every older proof. A personal API key counts only if issued with `"mfa": true`. |
| Yourself | Nobody changes their own access. |
| Last administrator | Nothing removes, suspends or resets the last person who can manage access for the organisation. |
| Invitations and resets | A single-use link, stored hashed, on the sign-in page: an invitation lasts seven days, a reset a day, at most three sends an hour. The person sets their own password; a reset first ends the old one and every session. One email signs in to one organisation. |
| Self-approval | A person linked to a rota record who can approve hours at their own site is flagged. |

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/me` | The key, the person it acts as, and their live permissions |
| `PATCH /v1/me` | Your own name and job title, for anyone signed in or on their own personal key. Email, roles and the rota link are not changed here; integration keys are refused |
| `GET /v1/access/catalogue` | Roles, permissions, paired-duty rules |
| `GET/POST /v1/users`, `GET/PATCH /v1/users/:id` | Directory, invite with first role, edit name, title and rota link |
| `POST /v1/users/:id/grants`, `PATCH/DELETE /v1/users/:id/grants/:mid` | Grant (422 refused, 409 `needs_confirmation`), change end date, revoke (kept, marked revoked) |
| `POST /v1/users/:id/suspend`, `/reactivate`, `/reset-authenticator`, `/resend-invite`, `DELETE /v1/users/:id/invite` | Account actions |
| `POST /v1/users/bulk` | One account action for many people, each checked in turn |
| `GET /v1/access/health` | What needs attention, and who covers each duty at each site |
| `GET/POST /v1/access/reviews` | Quarterly access reviews |
| `GET /v1/access/audit` | Every access change, newest first |
| `GET /v1/me/authenticator` | Whether your roles need one, whether it is set up, whether this session has entered a code, recovery codes left |
| `POST /v1/me/authenticator/start`, `/confirm` | A new secret and its QR code, then confirmation with a code from the app, which returns ten recovery codes once. Replacing one needs a session that has proved the current one |
| `POST /v1/me/authenticator/verify` | A 6-digit code or a recovery code for this session. Each code works once; five wrong in 15 minutes lock it for 15 minutes |
| `POST /v1/me/authenticator/recovery-codes` | Ten new recovery codes, replacing the old ones |
| `POST /v1/users/:id/reset-password` | Ends the password and every session; emails a single-use link, valid a day, for the person to set a new one, or returns it to hand over when email is not set up. Needs the authority to give the person every role they hold. For someone with rights that move money or reach confidential records the link is only ever emailed (409 `email_only` otherwise) |
| `/login?link=`, `POST /auth/accept`, `GET /auth/link` | Public: the person sets their own password from an invitation or reset link (single use), and is signed in |

## Endpoints

| Area | Endpoints |
| --- | --- |
| Reference | `GET /v1/sites`, `/v1/roles`, `/v1/demand-rules` |
| Set-up | A signed-in person (or their personal key) holding `settings.manage` organisation-wide, with a proved authenticator; never a system integration key. `GET /v1/setup/status` (still the sample group, and whether it can be cleared), `PUT /v1/setup` (companies, sites, roles and staffing rules in one go; refused with `invalid_setup` if incomplete and `in_use` if it removes a company, site or role that people, shifts, clocked time or someone's site access still use; re-forecasts from this week from each site's `salesProfile`), `POST /v1/setup/start-fresh` (clears the sample group, its fictional people and HR files; refused with `not_sample` once anything real exists, including HR records, a data request, or a real person's access tied to a sample site). People are not part of set-up: they are added through `POST /v1/employees` so each starter reaches payroll. |
| Employees | `GET/POST /v1/employees`, `GET/PATCH /v1/employees/:id`, `POST /v1/employees/:id/leaver` |
| Right to work copies | `POST /v1/employees/:id/right-to-work/documents?fileName=` with the file as the raw body (PDF, JPEG, PNG or WebP, up to 4 MB; the type is read from the bytes, anything else is 415), `GET .../documents/:docId` to view, `DELETE .../documents/:docId` (signed-in admins only), `GET .../documents/:docId/access` (the copy's access log, signed-in admins only). Each copy is listed on the employee's `rightToWork.documents` with its SHA-256, who added it and when. Editing the employee never changes that list. |
| HR copies | `POST /v1/hr/records/:id/files?fileName=` with the file as the raw body (a signed contract, a letter, a fit note, a certificate; the same types, size, encryption and access log as right to work copies; `hr.manage` at the person's home site, never your own file, and a case's copies only for those who handle cases), `GET /v1/hr/records/:id/files/:fileId` (logged on every view), `DELETE /v1/hr/records/:id/files/:fileId` (privacy.manage, a person). Copies are listed on the record's `files`, and are deleted with the record or when retention anonymises the person |
| Sick pay | `GET /v1/hr/sick-pay?siteId=&from=&to=` (those who read the person's HR file or run their pay): SSP due per sickness spell under the rules from 6 April 2026, from the first qualifying day at the lower of £123.25 a week and 80% of average weekly earnings over the eight weeks before, qualifying days being the weekdays the person was rostered on (Monday to Friday if none), spells 56 days apart or fewer linked, 28 weeks at most. With `from` and `to`, `inPeriod` is what falls in that pay period. Spells before 6 April 2026 are counted in `oldRules` and left to payroll. Each hours batch sent to payroll carries the period's `sickness` lines with our estimate, and a pay run that reports `ssp` per person is checked against it: `GET /v1/payroll/runs` carries `ssp: [{employeeId, expected, paid, difference}]` and a difference is audited as `payroll.ssp_mismatch` |
| HR | `GET /v1/hr/overview?siteId=` (headcount, turnover, absence and every open personnel file check), `GET/POST /v1/hr/records`, `PATCH/DELETE /v1/hr/records/:id` (training, reviews, cases, documents, notes), `PUT /v1/employees/:id/hr` (contract, probation, NI number, emergency contact, line manager), `POST /v1/employees/:id/absences`, `PATCH/DELETE /v1/employees/:id/absences/:absenceId` (responses list rostered shifts the absence now clashes with). Needs `hr:read` or `hr:write`. A key without them gets employees with no `hr` file and absences reduced to `{id, from, to}`, with `type` only for those who run pay (`payroll.view`, `pay.edit` or `pay.approve`), as sick pay turns on it. Whether someone was off sick is health data: the rota needs only the days. Cases are returned to signed-in people who handle them, never to members and never to an API key. Every record carries `history`: each change, who made it and the values it replaced, kept by the server. A record stays with its person (`person_fixed`), and a case is closed, never deleted (`case_kept`). Nobody changes their own staff record (`PATCH /v1/employees/:id`, `/leaver`) or exports their own subject file: somebody else does. |
| Shifts | `GET/POST /v1/shifts`, `PATCH/DELETE /v1/shifts/:id` (responses carry compliance issues) |
| Rota | `GET /v1/rota/week`, `POST /v1/rota/build`, `/clear`, `/publish` (publish refuses blocking breaches) |
| Rest overrides | `GET /v1/rota/overrides`, `POST /v1/rota/overrides` with `{weekStart, key, reason}`, `DELETE /v1/rota/overrides/:id`. Daily and weekly rest breaches carry an `overrideKey`; a person with the right to publish the rota at the breach's site (never a system key) posts it with a reason of at least 15 characters, and the breach publishes as a warning naming them and their reason. The key covers that breach as it stood: moving either shift, or changing the days worked, makes a new breach that blocks again. Overrides and withdrawals go to the audit log, and each publish records the overrides it went out under. |
| Forecast | `GET/PUT /v1/forecast` (Preshift Reports pushes hourly sales and covers here; a change to a modelled hour is kept as an override), `POST /v1/forecast/model` (baseline model for a site's week from till history; overridden hours keep their figure), `PATCH /v1/forecast/hour` (override one hour with a reason), `GET/POST /v1/forecast/adjustments`, `DELETE /v1/forecast/adjustments/:id` (weather, events, closures; a closure also closes the floor), `GET /v1/forecast/accuracy?siteId=&from=&to=`. `GET /v1/forecast/accuracy/report?siteIds=a,b&week=&weeks=` (1 to 26, default 8) is the same over several sites and weeks, by the day so a site that only keys in daily takings is measured too: for each site and week, the days measured (a forecast and takings, before today), day error and, where the till sends hours, hourly error, bias, sales over and under forecast and the labour each implies at the site's own target, the days that were on the typical week alone, and days of the week wrong by 10% or more the same way across three weeks or more. Sites the caller cannot see are left out; none at all is 403. Rows worked from a site's typical week carry `source: "profile"`; pushed rows never do, and always win. `POST /v1/rota/build` forecasts any week with no rows at all from the typical week first. `POST /v1/forecast/from-takings` `{siteId or siteIds, weekStart, replace?}` works the week out of each site's own takings: the same day 52 weeks back scaled by the last four weeks against the same weeks a year earlier (at least six matched days, a change between half and double), else the last six same weekdays with takings, the latest counting most and the highest and lowest dropped from five or more. Days with no takings count as closed. Hours split the day as the site's past forecasts for that weekday did, else a standard lunch and dinner curve; covers follow the site's own spend per head. Days already forecast are left alone unless `replace` is true; each day comes back with its basis, the takings days it used and a note |
| Takings | `GET/PUT/DELETE /v1/sales` (a till or EPOS integration pushes each day's net takings per site; `PUT` adds or replaces by site and day, `DELETE ?siteId&date` removes one so reports fall back to the forecast) |
| EPOS | `GET /v1/integrations/epos` (the connected till, which site takes which location, the last sync), `GET /v1/integrations/epos/locations`, `POST /v1/integrations/epos/sync` (`{from?, to?}`, defaults to the last seven finished days, at most 92 days; keeps days keyed in by hand). Connecting, matching and disconnecting need a signed-in person with settings.manage; syncing needs demand.manage at every matched site, the same right as keying takings in. |
| Calendar | `GET /v1/calendar?siteId=&from=&to=` (occasions, events, weather by day, what the model applies and why, reminders), `GET /v1/reminders?siteIds=` (what is due now), `POST /v1/reminders` (`done`, `dismiss`, or `expect` with a factor, which becomes a forecast adjustment; a second answer replaces the first), `PUT /v1/sites/:id/location`, `POST /v1/outside/refresh` (weather, feeds and the forecast ahead, now), `GET /v1/weather`, `GET/POST /v1/event-feeds`, `DELETE /v1/event-feeds/:id` (past events are kept as history), `GET/POST /v1/local-events`, `DELETE /v1/local-events/:id` (hand-entered only) |
| School holidays | `GET /v1/school-holidays?siteId=` (the council's dates where given, otherwise the estimate), `POST /v1/school-holidays` (from the council's page, by hand), `DELETE /v1/school-holidays/:id`, `PUT /v1/sites/:id/nation`; a council's term dates feed is an event feed with `kind: "school"` |
| Bookings | `PUT /v1/bookings` (push by the booking system's reference; only date, time, covers, status, made and cancelled dates are kept, anything else is dropped), `POST /v1/bookings/import` (a CSV export; columns found by name, UK dates unless `usDates`), `GET /v1/bookings`, `GET /v1/bookings/status` |
| Till actuals | `GET/PUT /v1/actuals` (hourly sales and covers as traded: what the model learns from and accuracy is measured against) |
| Coach | `POST /v1/coach/moves` (works out and records this week's moves), `POST /v1/coach/apply` (takes a move exactly as offered; refuses a stale one or one that now breaks a rule), `POST /v1/coach/dismiss` (with the reason), `GET /v1/coach/history` (with the saving each taken move actually realised), `GET /v1/scorecard?siteId=&weeks=` |
| Programme | `GET /v1/programmes`, `PUT /v1/programmes/:siteId`, `PUT /v1/programmes/:siteId/baseline`, `POST /v1/programmes/:siteId/signoffs`, `DELETE /v1/programmes/:siteId/signoffs/:milestoneId`, `POST /v1/programmes/:siteId/verifications` (all writes need the WS client partner, or a WS key with `programme:lead`) |
| Benchmarks | `PUT /v1/settings/benchmarking` (the operator's admin opts in), `GET /v1/benchmarks` (quartiles from other opted-in operators only) |
| Time | `POST /v1/time-entries/clock-in`, `/:id/clock-out`, manual `POST /v1/time-entries`, `PATCH`, `POST /approve` (returns `belowBreakMinimum`, recorded in the audit), `GET /compare`, `GET /break-check` (finished shifts below the legal rest break: `short` or `split`) |
| Clocking | `PUT`/`DELETE /v1/sites/:id/geofence`, `PUT`/`DELETE /v1/employees/:id/badge`, `POST /v1/time-entries/tap` (RFID card: clocks in, or out if already in). Device clock-in and clock-out take `location: {lat, lng, accuracyMetres}`; a fenced site refuses one missing or outside the fence (`location_required`, `outside_site`, `too_imprecise`). The fix's accuracy is allowed on top of the radius, up to the radius again, and fixes worse than 250 m are refused. A card tap from a reader fixed on site under its own API key (no person behind it) is not location checked and may send `at` for a tap held offline, never in the future. A card tap from a signed-in person's tablet or phone is location checked like a device clock. Any clock from a person is timed by the server; an `at` more than two minutes off is refused (`time_set_by_server`). Employee records carry `personalHidden: true` and `under18` for readers without `team.manage` or `hr.view` at the person's sites: date of birth, right to work detail and card number are withheld. |
| Staff app | Managers: `GET /v1/staff-logins`, `POST /v1/staff-logins/:employeeId/invite` (a one-time link, valid 7 days. Once email is set up under Settings it is emailed to the person's own address, their login's once they have joined, else the one on their record, and the answer is `{emailed: true, to, expiresAt}` with no link. `{handOver: true}`, no address or a send Resend refuses returns `{emailed: false, reason, path, expiresAt}` to pass on, `reason` being `handed_over`, `no_address`, `email_not_set_up` or `send_failed`. `GET /v1/staff-logins` carries each person's `lastEmail` with what Resend reported, bounces included. Once the person has set up their login, a new link, their password reset, only ever goes to the address they signed up with: `handOver` or no email set up is refused with `email_only` before any link is made, and a failed send returns no link. Closing the login and inviting again starts afresh. Every invite, set-up and close is also kept in a staff login log that is never trimmed, as the audit log is. `GET /v1/staff-logins/review?from=&to=` lists each login closed in the period, followed through its re-invite and re-join, flagged where the same person closed and re-invited it, the link was handed over, it was set up with a different email, or hours have been clocked by phone since, with a risk of high, medium or low; `POST /v1/staff-logins/review` `{caseId, outcome: genuine|concern, note}` signs one off, once, and never by whoever closed or re-invited it. Both need a person signed in with `audit.view` or `users.manage` across the organisation), `DELETE /v1/staff-logins/:employeeId`. Staff, with their own `ps_staff` session (30 days, signed with a key derived for staff only, so it is never accepted by the manager API): `POST /v1/staff/invite` (the invite in the body; the link carries it after `#`), `POST /v1/staff/join`, `/login`, `/logout`, `GET /v1/staff/me`, `POST /v1/staff/clock-in`, `/clock-out`, `/break-start`, `/break-end`. Recorded breaks are kept on the entry as `breaks: [{start, end}]` and set `breakMinutes` at clock-out; clocking out ends a running break. A card tap on `/v1/time-entries/tap` while on a break returns `break_end`. Five wrong passwords lock the login for 15 minutes. Phone clocking is refused at a site with no geofence (`site_not_set_up`). |
| Staff requests | Managers: `GET /v1/requests?siteId=&status=open\|all` (the sites where the caller decides each kind: holiday and availability need `team.manage`, time off and sickness `hr.manage` with an HR scope, swaps and open shift claims `rota.publish`; each carries `problem`, `issues`, `clashes`, `othersOff`, `balance` and `canDecide`, and notes on sickness and time off only for personnel file readers), `POST /v1/requests/:id/approve` and `/decline` (`{note?}`; approving is checked again and refused with `compliance_block` or `request_stale`; a swap needs the colleague's agreement first, `not_agreed`; nobody decides their own). `GET/POST /v1/open-shifts` (`{siteId, roleId, date, startMinute, endMinute, breakMinutes?, note?}`, or `{fromShiftId}` to take a shift off whoever has it and post it; answers `told`, the number of eligible people notified), `DELETE /v1/open-shifts/:id` (withdraw). `GET /v1/requests/late` (shifts running now that nobody has clocked in for, ten minutes or more after the start, at the sites where the caller publishes the rota), `GET /v1/requests/rota-seen` (this week and next, per site: who has confirmed their published week as it now stands, who has not, changed since, and who has no app), `GET /v1/insights/adoption?weeks=` (per site: team on the app and with notifications on, request decision times and what is waiting, open shifts posted and filled, no-shows at clocking sites; names of who to chase only where the caller manages the team). `GET /v1/requests/digest` (whether the caller's morning email is on, and what it would say today) and `PUT /v1/requests/digest` (`{on}`), signed-in people only. `GET /v1/employees/:id/absences/:absenceId/fit-notes/:docId` (`hr:read`, logged). Staff, on the `ps_staff` session: `GET /v1/staff/notifications`, `POST /v1/staff/notifications/read` (`{ids?}`), `GET /v1/staff/team`, `GET /v1/staff/board`, `GET /v1/staff/shifts/:id/swap-options`, `POST /v1/staff/swaps` (`{shiftId, toEmployeeId?, returnShiftId?, note?}`), `POST /v1/staff/swaps/:id/accept` and `/decline`, `POST /v1/staff/open-shifts/:id/claim`, `POST /v1/staff/requests/holiday` (`{from, to, note?}`), `/time-off` (`{absenceType, from, to, note?}`), `/availability` (`{availability}`), `POST /v1/staff/requests/:id/cancel`, `PUT /v1/staff/unavailable` (`{dates: [{date, note?}]}`), `POST /v1/staff/sick` (`{from?, note?}`), `/sick/back` (`{lastDayOff}`), `POST /v1/staff/fit-note?fileName=` (the file as the body). `GET /v1/staff/push` (the server's VAPID public key and the caller's phones), `POST /v1/staff/push/subscribe` (`{endpoint, keys: {p256dh, auth}, label?}`, Apple, Google, Mozilla or Microsoft push addresses only, else `invalid_subscription`; up to five phones), `POST /v1/staff/push/unsubscribe` (`{endpoint}`), `POST /v1/staff/push/test` (a test to the caller's own phones), `POST /v1/staff/rota/seen` (`{weekStart}`: Seen it on the person's published week as it now reads; a later change needs confirming again; `GET /v1/staff/me` carries `rotaToConfirm`), `PUT /v1/staff/reminders` (`{on}`, shift reminders; not-clocked-in nudges always come). `GET /v1/staff/me` adds `pushDevices`, `unread`, `holiday`, `availability`, `unavailable`, `sick`, `fitNoteFor` and `requests`. Publishing the rota, deleting a published shift and every decision notify the people concerned. |
| Kiosks | Managers: `GET /v1/kiosks`, `POST /v1/kiosks` (signed-in session only: sets the device's `ps_kiosk` credential for a year and ends the session on it), `DELETE /v1/kiosks/:id`. Kiosk, under its own credential: `GET /v1/kiosk/board` (today's rota at its site), `POST /v1/kiosk/tap` (a card, as a fixed reader), `POST /v1/kiosk/clock` (`in`, `out`, `break_start`, `break_end` by name, for people on today's rota there). Entries are recorded with method `kiosk` for by-name clocks and `card` for taps. PINs: `PUT /v1/sites/:id/kiosk-pin` (`required`), `POST /v1/employees/:id/kiosk-pin` (issues a random PIN, returned once), `DELETE /v1/employees/:id/kiosk-pin`, and `PUT /v1/staff/kiosk-pin` for a person setting their own. Where required, `/v1/kiosk/clock` takes `pin` and refuses with `no_pin`, `pin_required`, `wrong_pin` (with `triesLeft`) or `pin_locked`. Cards never need a PIN. |
| Support | `GET /v1/support/tickets` (the organisation's questions, bug reports and feature ideas, open and blocking first, with `desk`, the names who answer, and `youAreDesk`), `POST /v1/support/tickets` `{kind: question|bug|feature, title, detail, impact?, steps?, hoursSavedPerWeek?, context?}` (a bug's `impact` sets its severity; 30 a day per organisation), `POST /v1/support/answered`, `POST /v1/support/tickets/:id/vote`, `POST /v1/support/tickets/:id/comments`, `PATCH /v1/support/tickets/:id` `{status}`. People signed in only, never an integration key. The desk is the client's WS client partner (the `ws_partner` role across the organisation): only their reply stops the response clock and only they change a status. A new ticket emails each partner through their own WS organisation's email, and records `notified` (emailed, failed, not_set_up, no_desk). First response targets are London working hours, Monday to Friday, bank holidays excepted: blocking 4 working hours, major and questions 1 working day, minor 3, ideas 5. Closed tickets are deleted two years after closing and are listed in the record of processing. Off in the public demo |
| Travel | `PUT /v1/sites/:id/location` (`{postcode}`, looked up on postcodes.io, or `{lat, lng}`; clears looked-up journeys to and from the site), `POST /v1/sites/travel/refresh` (TfL journey planner for every pair of located sites, each way, weekday 17:00, public transport or walking; hand-set times kept; a labelled straight-line estimate where TfL has no answer), `PUT`/`DELETE /v1/sites/:id/travel/:toId` (`{minutes}` set by hand, both ways). Journeys are kept on each site as `travel: {siteId: {minutes, source: tfl\|estimate\|manual, mode, checkedAt}}`. Shift responses carry `travel` (blocking: cannot get there in time), `travel-tight` and `travel-unknown` issues. A same-day journey between sites is paid working time: costs, journals and payroll submissions include it, charged to the shift travelled to, and payroll hours lines carry `travelHours` (already inside `hours`). What a company pays for travel is set with `PATCH /v1/entities/:id` `{travelPay: {basis: normal\|minimum\|fixed, hourly?}}`: `minimum` is the minimum wage for each person's age, `fixed` needs `hourly` and is lifted to the minimum wage where it is lower, and `normal` clears the policy. Travel at a rate other than the person's normal rate is its own hours line with `travel: true` and that `rate`. `TFL_APP_KEY` is optional; the planner works without one at low volume. |
| Payroll | `GET /v1/integrations/payroll` (overall and per PAYE scheme), `POST /sync-employees`, `GET /outbox`, `POST /outbox/:id/retry`, `POST/GET /v1/payroll/submissions` (one batch per company; `entityId` for one company), `GET /v1/payroll/runs`, `PATCH /v1/entities/:id` (a company's TeamPay employer and PAYE reference), `PUT /v1/entities/:id/premiums` (`{premiums: [{id?, name, kind: day\|bank_holiday\|night\|overtime, multiplier? \| perHour?, weekdays?, fromMinute?, toMinute?, afterHours?, roleIds?}]}`, replaces the company's pay premiums for hourly staff; exactly one of `multiplier` (1 to 4) and `perHour` (0 to 50); `day` needs `weekdays` (0 Monday to 6 Sunday), `night` a window that may run past midnight, `overtime` pays after `afterHours` weekly hours or, without it, after contracted hours; where several apply to one hour only the highest is paid; audited as `entity.premiums_set` with each rule before and after in words). Costs, journals and the rota week (`metrics.cost.premium`) include them, and each hours batch carries premium lines with `premium: {ruleId, name}`, `hours` that qualified and `rate` as the uplift, on top of the normal line and left out of `totalHours`. Bank holidays follow England and Wales |
| Linking existing TeamPay staff | `GET /v1/integrations/payroll/link?entityId=` (`payroll.view`: the company's TeamPay records beside its people, with suggested matches, held starters and links awaiting a decision), `POST /v1/employees/:id/payroll-link` `{payrollId, keep?: 'payroll' \| 'preshift'}` (`payroll.send`; also settles an existing link's differences. Pay follows the two-person rule: `keep: 'payroll'` raises TeamPay's pay as a pay change for finance to approve and the person's hours wait until then; `keep: 'preshift'` overrides what TeamPay pays, so it needs `pay.approve`; never on your own pay; a business with nobody else who can approve applies either at once), `POST /v1/employees/:id/payroll-new-starter` (confirms a held starter is not on TeamPay), `DELETE /v1/employees/:id/payroll-link` (only before any hours have gone to TeamPay under it). Before creating a starter the outbox reads the employer's TeamPay employees: Preshift's own reference or exactly one record with the same name and date of birth is linked, not created; a near match (same date of birth and surname, or same name) is held with reason `possible_match`, two exact matches with `ambiguous_match`. Differences are never overwritten either way: the person carries `payrollReview`, nothing is sent to TeamPay for them, their name, date of birth, pay and hours cannot be edited, and an hours batch including anyone with an undecided pay difference is refused with `payroll_review`. |
| Finance | `GET /v1/journal?weekStart=&basis=rota\|actual\|auto&format=json\|xero-csv` |
| Appropriate policy document | `GET /v1/privacy/policy-documents` (with the register): each employing company's document for sickness and other health data and where it stands (`block` when sickness is held with none on record, `warn` when not reviewed, not signed or past review, else `ok`). `PUT /v1/privacy/policy-documents/:entityId` (privacy.manage, a person): `{title, url?, reviewedBy?, reviewedOn?, signedBy?, signedOn?, reviewDue?}`; a signature needs the director and the date, after the review. Review is due a year after signing unless set |
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

- Paths: `GET /employees`, `POST /employees`, `PATCH /employees/:id`, `POST /employees/:id/leaver`, `POST /hours`, `GET /pay-runs/:id`.
- Listing employees: assumed `GET /employees?include_leavers=true&page=N&per_page=100`, answering
  `{ employees: [...], next_page }` with `external_ref`, `date_of_birth`, pay and leave fields. Linking and the
  duplicate check depend on it; if it cannot be read, starters wait rather than risk a second record.
- Field names (snake case), and whether cost centre and role are accepted on hours lines.
- That premium lines are accepted on hours (`pay_element: 'premium'`, `premium_code`, `rate` as the uplift per qualifying hour), paid on top of the normal line rather than as extra hours.
- That one API key can act for several employers by naming one per call, and that the
  `payroll.run.completed` webhook says which employer the run is for (`employer_id`).
- Header names for the employer (`x-teampay-employer`), idempotency (`idempotency-key`) and the
  webhook signature (`x-teampay-signature: sha256=<hex HMAC of the raw body>`).
- How TeamPay treats a resubmitted hours batch for the same period (replace or add).
- Pay schedules other than weekly. Preshift periods are weekly in this build.
- That `POST /hours` accepts `sickness` (`employee_id`, `dates`, `qualifying_days_per_week`, `ssp_estimate`) and `adjustments` (`employee_id`, `amount`, `description`, `reference`, for back pay), and that a pay run returns `ssp` per person. Without `ssp` the pay run SSP check stays empty; without `adjustments`, back pay is keyed in TeamPay by hand.

Because WS runs TeamPay, these can be settled in one working session: `docs/TEAMPAY_CONFIRMATION.md` is the agenda, with a live check to run against the sandbox. Change that file, run
`npm test`, and the rest of the system is unaffected.

## Weather and local events

Weather comes from Open-Meteo: sixteen days ahead and the last week, plus a backfill of measured
weather for the days a site has till history, so the model can learn how that site trades in it.
Open-Meteo's free API is for non-commercial use: set `OPEN_METEO_API_KEY` to a paid key before
clients are charged, and calls move to its customer endpoints. Local events come from iCal feeds
added per site, from Ticketmaster within a radius when `TICKETMASTER_API_KEY` is set, or by hand.

Everything is fetched once a day per organisation by the scheduled `/internal/dispatch` run
(`CRON_SECRET`), which then refreshes the forecast for the rest of this week and next. One
organisation or feed failing never stops the rest, and a run stops before the function's time
limit, picking up the longest waiting first next time.

Feed fetches go only to public https addresses: the address is checked when added, and every
connection resolves the name and refuses it unless all its addresses are public, so a name that
resolves inwards (or changes between check and fetch) cannot reach a private network. Redirects
are refused, bodies are capped at 2 MB as they arrive, and feed addresses are never returned in
full, because private calendar links carry secret tokens.

## School holidays and children at work

There is no national feed of school term dates: each council publishes its own, and academies can
differ. Until a site has its council's dates, the usual England and Wales pattern is used and shown as
an estimate; Scotland and Northern Ireland get no estimate. A council's iCal feed (`kind: "school"`)
or dates entered by hand replace the estimate holiday by holiday.

The child employment rules (gov.uk, "Child employment") apply to anyone still of compulsory school
age by the site's nation. Because a holiday relaxes them, only confirmed holidays count: on an
estimated holiday a child is rostered as if school were open. The feed reader leaves out anything
doubtful and says so on the feed. Local byelaws can add limits and require a permit; the checks flag
the permit and bar work for someone to confirm, and do not replace reading the council's byelaws.

## Bookings

Bookings move the forecast for the dayparts they cover: covers on the books now, plus the pickup the
site's comparable days went on to get from the same point (learnt from at least four of the same
weekday and daypart in the last twelve weeks, leaving out unusual days). They are only used for a
day that has bookings loaded, at a site where bookings are a real share of trade, up to six weeks
out.

Personal data: only the fields above are ever read or kept. The CSV reader reads named columns only
and reports the columns it left behind; the push route drops any other field as the request is read;
the audit log records counts. Each day is compacted into pace history two days after it trades, and
the bookings themselves are deleted. A push never rewrites a day already in history; a full export
through the import replaces whole days.

Direct connections. All three main booking systems grant API access only on application:

- ResDiary: apply through ResDiary for API access (it carries a monthly fee). Its Data Extract API
  lists bookings created and changed on a date, which maps directly onto `PUT /v1/bookings`.
- SevenRooms: request API credentials (client id and secret) for the venue group from the SevenRooms
  account manager.
- OpenTable: apply to the partner programme (partnersupport@opentable.com).

Until access is granted, each system's scheduled CSV export through `POST /v1/bookings/import` does
the same job: daily for what is on the books, and once with three months of history so pickup can be
learnt.

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
| `/internal/webhooks` | Vercel Cron every 15 minutes: webhook retries that are due (needs `CRON_SECRET`) |
| `/internal/reminders` | Vercel Cron every 5 minutes: shift reminders the evening before and two hours before, and not-clocked-in alerts ten minutes after the start (needs `CRON_SECRET`) |
| `/internal/digest` | Vercel Cron at 06:35 UTC: each manager's morning email of staff requests waiting for them, once a day per organisation with email set up (needs `CRON_SECRET`) |
| `/demo`, `/demo/start` | The public demo's start page, and the form post that starts a visitor's sandbox (with `PRESHIFT_DEMO=1`) |
| `/internal/demo-reset` | The demo's midnight reset, from Vercel Cron at 23:05 and 00:05 UTC (needs `CRON_SECRET`) |

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
