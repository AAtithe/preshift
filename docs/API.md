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
| `TEAMPAY_EMPLOYER_ID` | The client company's employer in TeamPay |
| `TEAMPAY_WEBHOOK_SECRET` | Signing secret for inbound webhooks |
| `PRESHIFT_API_KEYS` | JSON list of `{key, orgId, name, scopes, userId?}`; a `dev-key` (acting as the demo owner) exists only outside production |

## Authentication and tenancy

Bearer API keys, each bound to one organisation with scopes: `rota:read`, `rota:write`,
`time:write`, `time:approve`, `payroll:write`, `users:manage`, or `*`. A GM key can build rotas and approve
time but cannot send hours to payroll; that is a payroll or finance key. Every request is
confined to its key's organisation.

A key with a `userId` is a personal key: on every route it acts as that person, so their key's
scopes and their roles must both allow it, at the site in question (`server/guard.ts`). A key
without one is a system key with organisation-wide authority. The web app uses a personal key;
outside production each seeded person has one (`dev-<userId>`) and the demo can sign in as any of them.

| Route | Needs, at the site |
| --- | --- |
| Sites, shifts, demand rules, forecast, staff list | `rota.view` (staff: or `team.manage`). Lists are trimmed to those sites |
| Shift changes, build, clear | `rota.edit` (a moved shift, at both sites) |
| Publish | `rota.publish` |
| Forecast upload | `demand.manage` at every site in the upload |
| Rota week's cost, staff pay rates | `costs.view` or `pay.edit`; otherwise `metrics` is null and pay reads nought with `payHidden` |
| Starters, changes, leavers | `team.manage`; a rate, salary or pay basis also `pay.edit`, never on your own record |
| Clocking, manual entries, edits | `time.record` |
| Time entries and rota against clock | `time.record`, `time.approve` or `payroll.view` |
| Approval | `time.approve`; your own hours are skipped by range (`ownSkipped`) and refused by id |
| Payroll status, submissions, runs, outbox | `payroll.view` |
| Sync, send hours, retry | `payroll.send` |
| Labour accrual journal | `close.export` |

## Users and access

The model follows Signal. A user record grants nothing. Access comes from memberships: a role,
for the whole organisation or named sites, live between a start and an optional end date. The
rules live in `src/engine/access.ts`, which the API enforces and the browser runs for live feedback.

| Rule | Effect |
| --- | --- |
| No granting beyond your own | You can only grant permissions you hold where you grant them. The Owner and the WS client partner may appoint to their side without holding each duty, so the Owner can appoint a payroll manager without sending pay. |
| Site managers | A GM or area manager grants site roles at their own sites only, and sees only the people at those sites. |
| Sides | Operator roles are granted by the operator, WS roles by the WS client partner, outside roles always carry an end date. |
| Paired duties | Checked across every role a person holds. Pay rates with sending payroll is refused. Starters with payroll, approving hours with pay rates, and access management with payroll need an accepted reason, which is kept on the grant. |
| Authenticator | Pay, payroll, locking, the journal, settings and access management stay off for a role that requires an authenticator until one is set up. |
| Yourself | Nobody changes their own access. |
| Last administrator | Nothing removes, suspends or resets the last person who can manage access for the organisation. |
| Invitations | Single-use token, stored hashed, valid seven days, at most three sends an hour. |
| Self-approval | A person linked to a rota record who can approve hours at their own site is flagged. |

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/me` | The key, the person it acts as, and their live permissions |
| `GET /v1/access/catalogue` | Roles, permissions, paired-duty rules |
| `GET/POST /v1/users`, `GET/PATCH /v1/users/:id` | Directory, invite with first role, edit name, title and rota link |
| `POST /v1/users/:id/grants`, `PATCH/DELETE /v1/users/:id/grants/:mid` | Grant (422 refused, 409 `needs_confirmation`), change end date, revoke (kept, marked revoked) |
| `POST /v1/users/:id/suspend`, `/reactivate`, `/reset-authenticator`, `/resend-invite`, `DELETE /v1/users/:id/invite` | Account actions |
| `POST /v1/users/bulk` | One account action for many people, each checked in turn |
| `GET /v1/access/health` | What needs attention, and who covers each duty at each site |
| `GET/POST /v1/access/reviews` | Quarterly access reviews |
| `GET /v1/access/audit` | Every access change, newest first |
| `POST /v1/invites/accept` | Public; the token is the proof |

## Endpoints

| Area | Endpoints |
| --- | --- |
| Reference | `GET /v1/sites`, `/v1/roles`, `/v1/demand-rules` |
| Employees | `GET/POST /v1/employees`, `GET/PATCH /v1/employees/:id`, `POST /v1/employees/:id/leaver` |
| Shifts | `GET/POST /v1/shifts`, `PATCH/DELETE /v1/shifts/:id` (responses carry compliance issues) |
| Rota | `GET /v1/rota/week`, `POST /v1/rota/build`, `/clear`, `/publish` (publish refuses blocking breaches) |
| Forecast | `GET/PUT /v1/forecast` (Preshift Reports pushes hourly sales and covers here) |
| Time | `POST /v1/time-entries/clock-in`, `/:id/clock-out`, manual `POST /v1/time-entries`, `PATCH`, `POST /approve`, `GET /compare` |
| Payroll | `GET /v1/integrations/payroll`, `POST /sync-employees`, `GET /outbox`, `POST /outbox/:id/retry`, `POST/GET /v1/payroll/submissions`, `GET /v1/payroll/runs` |
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

## What must be confirmed with the TeamPay API reference

The TeamPay client (`server/integrations/payroll/teampay.ts`) is the only file that knows
TeamPay's paths and field names. It follows what TeamPay publishes (REST, push hours and
starters, pull pay runs, `payroll.run.completed` webhooks, sandbox keys), but these details are
assumptions until checked against the API reference:

- Paths: `POST /employees`, `PATCH /employees/:id`, `POST /employees/:id/leaver`, `POST /hours`, `GET /pay-runs/:id`.
- Field names (snake case), and whether cost centre and role are accepted on hours lines.
- Header names for the employer (`x-teampay-employer`), idempotency (`idempotency-key`) and the
  webhook signature (`x-teampay-signature: sha256=<hex HMAC of the raw body>`).
- How TeamPay treats a resubmitted hours batch for the same period (replace or add).
- Pay schedules other than weekly. Preshift periods are weekly in this build.

Because WS runs TeamPay, these can be settled in one working session. Change that file, run
`npm test`, and the rest of the system is unaffected.

## Moving to production

- Swap `MemoryStore` for Postgres; each collection on `OrgData` becomes a table keyed by
  `org_id`, and the outbox insert shares a transaction with the change that caused it.
- Run the outbox dispatcher as a worker rather than a timer in the API process.
- Per-organisation TeamPay credentials (the code already resolves the provider per org).
- Staff authentication for the mobile app (clocking) alongside API keys for systems.
- Sign-in for people: passwords or SSO, TOTP enrolment that sets `mfaEnrolled`, sessions ended on
  suspend, revoke and authenticator reset, and invitation emails instead of returning the link.
