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
| `PRESHIFT_API_KEYS` | JSON list of `{key, orgId, name, scopes}`; a `dev-key` exists only outside production |

## Authentication and tenancy

Bearer API keys, each bound to one organisation with scopes: `rota:read`, `rota:write`,
`time:write`, `time:approve`, `payroll:write`, or `*`. A GM key can build rotas and approve
time but cannot send hours to payroll; that is a payroll or finance key. Every request is
confined to its key's organisation.

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
