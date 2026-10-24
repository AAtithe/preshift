# TeamPay API: what to confirm before a client goes live

Preshift's TeamPay integration has only ever run against the simulator. TeamPay publishes no API
reference, so every path and field below is an assumption. This page is the agenda for one working
session with TeamPay: confirm or correct each line, change `server/integrations/payroll/teampay.ts`
(the only file that knows TeamPay's paths and fields), run `npm test`, then run the live check at
the bottom against a TeamPay sandbox.

Until this is done, set no `TEAMPAY_*` variables on the live system. Without them it stays on the
simulator, which is safe, and a real client cannot be paid through Preshift.

## Connection

| # | Assumption | Why it matters | Confirmed |
| --- | --- | --- | --- |
| 1 | REST over HTTPS at a base URL such as `https://api.team-pay.co.uk/v1`, with separate sandbox and production keys | Where every call goes | |
| 2 | `Authorization: Bearer <api key>` | Every call is refused without it | |
| 3 | One API key can act for several employers (PAYE schemes), naming one per call in an `x-teampay-employer` header | A group's companies each run their own payroll. If a key is per employer, Preshift needs one key per company | |
| 4 | An `idempotency-key` header makes a repeated call a no-op | The outbox retries after timeouts. Without it, a retried starter or hours batch could be duplicated | |
| 5 | 429 and 5xx are worth retrying; other 4xx are not | Decides what the outbox retries and what it stops on | |

## People

| # | Assumption | Why it matters | Confirmed |
| --- | --- | --- | --- |
| 6 | `POST /employees` creates a starter and returns `{ id }` | Starters | |
| 7 | `PATCH /employees/:id` updates them | Pay, hours and name changes | |
| 8 | Fields, snake case: `external_ref`, `name`, `date_of_birth`, `cost_centre`, `pay_basis` (`hourly` or `salaried`), `hourly_rate`, `annual_salary`, `contracted_hours`, `irregular_hours`, `pension_enrolled`, `start_date` | A wrong name is silently ignored or rejected | |
| 9 | `external_ref` is stored and returned, so a record Preshift created can be recognised later | Linking recognises its own earlier records by it | |
| 10 | `GET /employees?include_leavers=true&page=N&per_page=100` lists the employer's people, answering `{ employees: [...], next_page }` with the fields in line 8 plus `leave_date` | The duplicate check and the "Link existing TeamPay people" screen depend on it. If it is missing or different, starters wait rather than duplicate, so onboarding stops until it is fixed | |
| 11 | Leavers stay in the list with a `leave_date` | A leaver must never be offered for linking | |
| 12 | `POST /employees/:id/leaver` with `{ leave_date }` | Leavers and P45s | |
| 13 | Where NI number, tax code and bank details live: in TeamPay only, never sent by Preshift | Preshift deliberately does not hold them. Confirm TeamPay collects them from the starter | |

## Hours and pay runs

| # | Assumption | Why it matters | Confirmed |
| --- | --- | --- | --- |
| 14 | `POST /hours` takes `{ period_start, period_end, source, lines: [{ employee_id, cost_centre, role, hours, rate, reference }] }` and returns `{ id }` | Approved hours reach payroll | |
| 15 | Cost centre and role are accepted on each line | Labour costed to the right site and role in the pay run | |
| 16 | Sending a batch again for the same period replaces the earlier one rather than adding to it | Preshift supersedes a batch when hours are corrected. If TeamPay adds, people are paid twice | |
| 17 | Pay frequency: Preshift periods are weekly. Which schedules do clients run (weekly, fortnightly, four-weekly, monthly)? | Batches must match the client's pay schedule | |
| 18 | `GET /pay-runs/:id` returns per employee `employee_id`, `external_ref`, `gross`, `holiday_pay`, `employer_ni`, `employer_pension` | The pay run is reconciled to the accrual | |
| 22 | Premium lines are accepted on `POST /hours`: `pay_element: 'premium'` with `premium_code`, `hours` that qualified and `rate` as the uplift per hour, paid on top of the same hours' normal line and not counted as extra hours | Sunday, bank holiday, night and overtime premiums are paid as costed, and show on the payslip as their own element | |

## Webhooks

| # | Assumption | Why it matters | Confirmed |
| --- | --- | --- | --- |
| 19 | `payroll.run.completed` (and `payroll.run.flagged`) are posted to `/v1/integrations/teampay/webhook/:orgId` | The pay run comes back | |
| 20 | Signed in `x-teampay-signature: sha256=<hex HMAC of the raw body>` with a shared secret | Anyone could post a fake pay run without it | |
| 21 | The body names the employer: `data.employer_id`, plus `data.pay_run_id`, `period_start`, `period_end`, and an event `id` for de-duplication | Routes the run to the right company | |

## Live check against the sandbox

1. Set `TEAMPAY_BASE_URL`, `TEAMPAY_API_KEY`, `TEAMPAY_WEBHOOK_SECRET` (and `TEAMPAY_EMPLOYER_ID` for a single company) on a preview deployment, never production first.
2. In a test organisation, put two people on the TeamPay sandbox by hand, one with a different rate.
3. Add the same two in Preshift. Expect one linked automatically and one held under "Needs a decision" in Payroll. No new TeamPay records.
4. Add a third person not on TeamPay. Expect one new TeamPay record carrying their `external_ref`.
5. Clock, approve and send hours. Expect one batch in TeamPay, with cost centres and roles. With a Sunday premium set on the company and a Sunday shift worked, expect a premium line on top of the hours, paid at the uplift.
6. Send again after a correction. Expect the batch replaced, not added to (line 16).
7. Run payroll in the sandbox. Expect the webhook to arrive, verify, and the pay run to reconcile in Preshift.
8. Mark a leaver. Expect the leave date in TeamPay.

Only after all eight pass should `TEAMPAY_*` go on the live system.
