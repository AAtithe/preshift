# Preshift Rota

The rota built by finance people who have run hospitality floors. A joint venture between
Williams, Stanley & Co. and [Preshift](https://preshift.co.uk/).

Every rota tool on the market answers "who is working when". Preshift answers the question an
operator actually cares about: "what will this week's labour cost me against what I will take,
and is it legal". It builds the rota from the sales forecast, costs every shift the way payroll
will, blocks anything that breaks UK employment law, and hands finance a ready-to-post labour
accrual so the P&L carries true labour before payroll has even run.

## What's new: week of 19 October 2026

A one-page card for the team. Read it in two minutes, then open the app and try each item once.
Past cards live in `docs/WHATS_NEW.md`.

| For | What changed | Why it matters |
| --- | --- | --- |
| GMs | Left-hand management bar groups the app into Overview, Rota, People, Finance and Admin. Site-only sections stay visible at group level and ask for a site. | The map never moves, so nobody hunts for a tab when they switch from group to site. |
| GMs | Clock in tab for a tablet at the door: RFID card tap (USB reader or Android NFC) or sign in by name inside the site's geofence. | Hours come from the door, not from memory, so the accrual and payroll start from evidence. |
| Staff | Staff app at `/staff/`: clock in and out on their own phone, record breaks, see their own shifts and hours. Invite link from Clock in setup, valid 7 days. | Breaks are recorded when taken, so unpaid minutes are a fact at clock-out, not an argument at payroll. |
| Finance | Payroll runs per PAYE scheme: one TeamPay employer per company, one batch of hours per company, each pay run reconciled to its own company's accrual. | Group structures with a central employer or sister-company cover now post and reconcile correctly. |
| Finance | Employment Allowance applied to the claiming entity week by week, posted to its books only, resetting each tax year. | Employer NI in the accrual matches what payroll actually charges. |
| Admin | Accounts, roles, passwords and the Claude key are managed in Settings. Forgot password by email through Resend, or a 24 hour link an admin hands over. | No access settings live in Vercel. Removing someone takes effect on their next click. |
| GMs | Short daily rest (under 11 hours, 12 for under 18s) and no clear day off in the week now block publication instead of warning. The auto-build and the assistant will not create either. | The rota cannot be published in breach of the Working Time Regulations rest rules, which is the promise we sell. |
| GMs | Rest breaches can be overridden from the Rota tab with a written reason and the compensatory rest given. The breach then publishes as a warning with the manager's name on it; moving either shift voids the override. | Real exceptions (sickness cover, a swap the person asked for) do not stop the week going out, and every one is on record. |
| Everyone | CI typechecks and runs the full suite (130 tests) on every pull request and on main. | A red build is caught before it reaches a site, not after. |

The test for this week: take one site through a full cycle. Build the week, publish it, clock two
people in on the tablet and one on a phone, approve the hours, send them to payroll and post the
accrual. If any step needs an explanation, that is the next thing to fix.

## Feature list

| Area | What it does | Where |
| --- | --- | --- |
| Demand-led build | Turns hourly forecast sales and covers into headcount per role (sales per labour hour or covers per person, with floors and caps), then fills the gaps peak-first, cheapest legal person first, and trims overstaffed edges. Gaps it cannot fill legally are reported as a hiring or cross-training signal. | `src/engine/demand.ts`, `src/engine/autoschedule.ts` |
| True cost per shift | Gross pay, holiday accrual (12.07%), employer NI at 15% over the £96 weekly threshold, auto-enrolment pension on qualifying earnings, guaranteed contracted hours. On-costs are worked on the whole week then spread over shifts, so the rota reconciles to payroll. | `src/engine/cost.ts`, `src/engine/ukRates.ts` |
| Marginal cost | The shift editor shows what a shift adds to the week, not a naive rate x hours. Someone on guaranteed hours costs nothing extra; someone already over the NI threshold costs 15% more than the headline rate. | `src/ui/ShiftEditor.tsx` |
| UK compliance | Working Time Regulations breaks, 11 hour daily rest (across week boundaries), weekly rest, 48 hour average without opt-out, young worker limits (8h/day, 40h/week, 30 minute break, 12h rest, night work), minimum wage by age, double booking, leave, availability, training. Blocking issues stop publication. | `src/engine/compliance.ts` |
| Live labour % | Forecast sales, loaded labour, labour % against the site target, pound variance, SPLH, by day and week. | `src/engine/metrics.ts`, `src/ui/KpiBar.tsx` |
| People | Employee records: details, employment dates, roles, contract and pay, right to work, availability and leave. Each record is checked before it reaches the rota: right to work missing or expired, pay below the legal minimum, upcoming birthdays that move the minimum wage band, salaried pay that falls below minimum wage at maximum hours, under 18 opt-outs, auto-enrolment eligibility. Starters and leavers are pro-rated in cost, kept off the auto-build outside their dates, and exported for payroll. | `src/engine/employees.ts`, `src/ui/PeopleView.tsx`, `src/ui/EmployeeEditor.tsx` |
| Rota assistant | The GM tells it what they need in plain English ("Ben is off Saturday, re-cover the bar without going over target") and Claude drafts the week by calling the engine's own tools. Every shift it proposes is costed by the payroll model and checked by the compliance engine; anything with a blocking issue is refused, so it cannot roster illegally. The GM sees labour % before and after, the changes, and a short note on gaps and trade-offs, then applies or discards the draft. | `src/ai/rotaTools.ts`, `src/ai/rotaAgent.ts`, `src/ui/AssistantPanel.tsx` |
| Close | Labour accrual journals by role nominal and site tracking category, one per entity, from approved actuals once available, otherwise the rota, exported in Xero manual journal format. | `src/engine/journal.ts`, `src/ui/CloseView.tsx` |
| Multi-site | Group and entity views put every site side by side with entity subtotals and a sales-weighted group target. One press builds every site in scope: each site's own team first, then cover from people who have agreed to work other sites. Cross-site cover is reported each week. | `src/engine/metrics.ts`, `src/engine/autoschedule.ts`, `src/ui/GroupView.tsx` |
| Multi-entity | Sites trade in an entity and people are employed by one, which need not be the same (a central employing company, or cover at a sister company's site). Cost lands where the work was done; the wages accrual stays with the employer; the difference posts as an intercompany recharge on both sides, checked to agree before posting. | `src/engine/types.ts`, `src/engine/journal.ts` |
| Payroll per PAYE scheme | Each company has its own TeamPay employer. Starters, leavers and approved hours go to the scheme of the company that employs the person, wherever they worked; hours go as one batch per company, and each pay run comes back to its company and is reconciled against that company's accrual only. Nothing is sent until every company with hours has an employer, and moving a synced person between schemes is refused because it is a leaver and a starter. | `server/payrollEmployers.ts`, `server/routes/payroll.ts`, `server/outbox.ts` |
| Employment Allowance | One claim per connected group, set on the claiming entity with what the last payroll left unused. Used against that entity's employer NI week by week until it runs out, as payroll applies it, and posted to its books only (Cr employer NI, Dr wages accrual) split across its sites. Resets each tax year. Site labour % stays before the allowance. | `src/engine/allowance.ts`, `src/engine/journal.ts` |
| API | Fastify REST API with OpenAPI docs at `/docs`, scoped API keys and per-organisation tenancy. The web app runs entirely on it. | `server/` |
| TeamPay, native | Starters, changes and leavers sync to TeamPay as they are saved. Approved clocked hours go to TeamPay through an idempotent, retrying outbox. Signed `payroll.run.completed` webhooks bring the pay run back and reconcile it to the accrual. | `server/integrations/payroll/`, `server/outbox.ts`, `src/ui/PayrollView.tsx` |
| Time and attendance | Clock in and out (UK wall-clock time, overnight shifts), manual entries, manager approval, rota against clock by person, period locking once sent to payroll. | `server/routes/time.ts`, `src/engine/timesheet.ts` |
| Shift sign-in | Clock in tab for a tablet at the site entrance: staff tap an RFID card (USB keyboard reader, or a phone's NFC on Android Chrome) or sign in by name. Each site can have a geofence; signing in by name on a device must happen inside it, and the location is kept on the time entry. Repeat reads of one tap are ignored. | `src/ui/ClockView.tsx`, `server/routes/clocking.ts`, `src/engine/clocking.ts` |
| Staff app | Staff clock in and out on their own phones at `/staff/`, record their breaks, and see their own published shifts and hours. Breaks are not location checked (they only lower paid time); recorded breaks set the entry's unpaid minutes at clock-out, the phone shows the legal minimum for the shift, and a card tap during a break ends the break. A manager sends a one-time invite link from Clock in setup (valid 7 days; a new one resets a forgotten password). Phone clocking needs the site's geofence, both ways. Staff logins are separate from manager accounts and reach nothing else; closing a login or marking a leaver ends it at once. | `src/staff/`, `staff/index.html`, `server/routes/staff.ts` |

## Specification

The detail behind the feature list. Every figure here is in the code; if they disagree, the code
is right and this section is out of date.

### Labour costing (`src/engine/cost.ts`, `src/engine/ukRates.ts`)

| Parameter | 2026/27 value |
| --- | --- |
| National Living Wage (21+) | £12.71 an hour |
| NMW 18 to 20 | £10.85 an hour |
| NMW 16 to 17 and apprentice rate | £8.00 an hour |
| Employer NI | 15% above £96 a week (secondary threshold) |
| Auto-enrolment pension | 3% employer on qualifying earnings £120 to £967 a week; trigger £192 a week; ages 22 to 66 |
| Holiday accrual | 12.07% of hours worked for hourly and irregular-hours staff (5.6 / 46.4) |
| Employment Allowance | £10,500 a year, one claim per connected group |

On-costs are calculated on the whole week, then spread across that week's shifts, so the rota
total reconciles to payroll. The shift editor shows marginal cost: what the shift adds to the week.

### Compliance rules (`src/engine/compliance.ts`)

Blocking issues stop publication and are refused by the assistant. Warnings are shown and allowed.

| Rule | Severity |
| --- | --- |
| Minimum wage for the person's age band | Block |
| Rest breaks under the Working Time Regulations; 30 minutes over 4.5 hours for under 18s | Block |
| Under 18s: 8 hours a day, 40 hours a week | Block |
| Double booking across any site, on leave, outside employment dates, right to work missing or expired | Block |
| 11 hours daily rest, checked across week boundaries; 12 hours for under 18s | Block |
| Weekly rest: one clear day in the rota week, two for under 18s | Block |
| Under 18 working between 22:00 and 06:00 (check the hospitality exemption) | Warn |
| Outside stated availability, or not trained for the role | Warn |
| Over 48 hours without an opt-out (must average 48 or less over 17 weeks) | Warn |
| Over the person's own maximum weekly hours | Warn |
| Below contracted hours on a full week (the gap is paid regardless) | Warn |

Rest breaches, and only rest breaches, can be overridden by a signed-in manager with a reason of at
least 15 characters (why, and the compensatory rest the person gets). The breach then publishes as a
warning carrying the manager's name and reason. An override covers that breach exactly as it stood:
move either shift, or change the days worked, and it blocks again. API keys cannot override, the
auto-build and the rota assistant never rely on one, and every override, withdrawal and publish
through one is in the audit log. Routes: `GET`, `POST /v1/rota/overrides`, `DELETE /v1/rota/overrides/:id`.

### Demand-led build (`src/engine/demand.ts`, `src/engine/autoschedule.ts`)

- Input: hourly forecast net sales and covers per site, from `PUT /v1/forecast`.
- Per role and site: sales per labour hour or covers per person per hour, a floor while open and a cap.
- Fill order: peak hours first, cheapest legal person first, own-site team before cross-site cover.
- Edges trimmed where overstaffed. Unfillable gaps are reported as a hiring or cross-training signal.

### Rota assistant (`src/ai/`, `server/routes/assistant.ts`)

- Claude drafts changes by calling the engine's own tools; it never writes shifts directly.
- The server route accepts one fixed model, caps output at 16,000 tokens and refuses streaming.
- The organisation's key is held server side, shown only by its last four characters.
- The GM sees labour % before and after, the changes and the trade-offs, then applies or discards.

### Finance outputs (`src/engine/journal.ts`)

- Labour accrual journal per entity, by role nominal and site tracking category.
- Basis: approved actuals when available, otherwise the rota (`basis=rota|actual|auto`).
- Format: JSON or Xero manual journal CSV.
- Intercompany recharge posted on both sides where a person works at another company's site,
  checked to agree before posting.

### Time, clocking and the staff app

| Item | Specification |
| --- | --- |
| Geofence | Per site. Fix accuracy is allowed on top of the radius, up to the radius again. Fixes worse than 250 m are refused. |
| Card taps | Not location checked, as the reader is fixed on site. Repeat reads of one tap are ignored. A tap during a break ends the break. |
| Phone clocking | Requires the site's geofence, for clock-in and clock-out. Refused at a site with no fence. |
| Breaks | Not location checked. Recorded as `{start, end}` and set unpaid minutes at clock-out. Clocking out ends a running break. |
| Approval | Manager approval, rota against clock by person, period locked once sent to payroll. |

### Access and security

| Item | Specification |
| --- | --- |
| Manager sessions | 12 hours, HttpOnly cookie, checked against the database on every request. |
| Staff sessions | 30 days, separate signing key, never accepted by the manager API. |
| Passwords | scrypt hashes. Five wrong attempts lock the account for 15 minutes. |
| Password reset | Single-use email link valid 30 minutes, at most three emails an hour per account, token after `#`. Admin-issued link valid 24 hours. |
| Staff invite | One-time link valid 7 days; a new invite resets a forgotten staff password. |
| Roles | Admin and member. At least one admin per organisation; nobody can remove themselves. |
| API | Scoped API keys, per-organisation tenancy, OpenAPI docs at `/docs`. TeamPay webhooks HMAC signed. |

### Platform

| Item | Specification |
| --- | --- |
| Stack | TypeScript throughout. React 18 and Vite for the web and staff apps; Fastify 4 for the API. |
| Storage | Postgres (Neon) via `PRESHIFT_DATABASE_URL`; in memory without it. Never reads `DATABASE_URL`. |
| Payroll | TeamPay, through an idempotent, retrying outbox; daily Vercel Cron retry. |
| Hosting | Vercel Build Output API: marketing site, one Node API function, app served to signed-in people only. |
| Quality | 130 tests across 9 files (engine, assistant, API, access, clocking, staff, payroll, Postgres store, reset). CI typechecks and tests every pull request and every push to main. |

## Running it

```bash
npm install
npm run dev      # API on :8787, web app on http://localhost:5173, API docs on /docs
npm test         # engine and API tests (130 across 9 files)
npm run build    # typecheck and production build
```

Locally, sign in as `dev@preshift.local` with password `preshift-dev-password`. That account only
exists when the API runs without a database, and is never created on the live system.

## Sign in, people and settings

Everything about access is managed inside the app, under Settings. Nothing is configured in
environment variables.

- First run. On a system with no accounts yet, the sign-in page offers "Create the owner account".
  Whoever completes it first becomes the owner (an admin), so do it straight after the first deploy.
  It can only ever happen once, enforced in the database.
- Who can sign in. Separate from the People tab, which holds staff records. Admins add accounts with a first password and a role, reset passwords, change roles and
  remove people. Members use the app but cannot manage access. Every organisation keeps at least
  one admin, and nobody can remove themselves.
- Rota assistant. An admin saves the organisation's Claude API key. It is kept on the server, shown
  afterwards only by its last four characters, and used only for the assistant's own requests (one
  model, capped output). Set a monthly spend limit on it in the Claude Console all the same.
- Your password. Anyone can change their own; doing so signs out their other devices.

Accounts, password hashes (scrypt), the session signing key and the Claude key all live in the
Preshift database. Sessions last 12 hours in an HttpOnly cookie and are checked against the database
on every request, so removing someone or resetting their password takes effect at once. Five wrong
passwords lock an account for 15 minutes. The web app carries no API key: it calls the API with the
session. On Vercel the app's files are served by the API function only to signed-in people. People who
forget their password use "Forgot your password?" on the sign-in page: a single-use link, valid for 30
minutes, is emailed through Resend once an admin saves a Resend key, a from address and the app's address
under Settings. The reply never says whether an account exists, one account gets at most three emails an
hour, and the link's token sits after `#` so it never reaches a server log. Until email is set up, an admin
makes a 24 hour link with "Reset link" and hands it over. Known limit: two roles only.

The demo runs a small group: West End Dining Ltd (Marylebone and Fitzrovia) and East Canteen &
Kitchen Ltd (Shoreditch), with realistic teams, rates and forecasts, against a TeamPay simulator.
A few people cover sister sites, and one Shoreditch bartender covers Marylebone, which is a
cross-company recharge. Choose an entity and site in the top bar, or leave both on "All" for the
group view, and press "Build" to generate the week. The rota assistant and the Payroll tab work on
one site, so they appear once a single site is selected. On the Payroll tab: set people up in
TeamPay, simulate clocking, approve, send hours, run payroll. Set the `TEAMPAY_*` variables to
connect to real TeamPay and `PRESHIFT_DATABASE_URL` for Postgres; see `docs/API.md`, which also
covers the Vercel deployment.

## Deployment (Vercel)

`npm run build:vercel` (set in `vercel.json`) writes `.vercel/output` with the Build Output API:

| Path | What |
| --- | --- |
| `/` | Marketing site, from `site/` |
| `/v1`, `/docs`, `/health` | The API, bundled into one Node function from `server/vercel.ts` |
| `/login`, `/auth/*` | Sign-in, first-run owner setup and sign-out, served by the API function |
| `/app/` | Web app, served by the API function to signed-in people only (`server/routes/web.ts`) |
| `/api/anthropic/v1/messages` | The rota assistant's route to Claude, using the key saved in Settings |
| `/internal/dispatch` | Daily Vercel Cron retry of payroll changes TeamPay has not confirmed (needs `CRON_SECRET`) |

Set `PRESHIFT_DATABASE_URL` to a Neon database that belongs to Preshift and the API keeps its data
in Postgres across cold starts and instances. Without it, data is held in memory and resets when
the function cold starts: fine for a demo, not for customers. Preshift never reads the generic
`DATABASE_URL`, so it cannot write into another system's database by accident. The hosted API has
no public key: people reach it by signing in, and integrations need a key from `PRESHIFT_API_KEYS`.

## Structure

```
src/engine   Pure TypeScript domain logic, shared by API, browser and assistant. Fully unit tested.
src/ai       The rota assistant: tools over the engine, and the Claude loop that drives them.
server       The Preshift API: routes, sign-in, people and settings, API keys, tenancy, Postgres store, payroll outbox, TeamPay client and simulator.
src/ui       React web app, a client of the API.
site         Marketing site (static, no build step).
scripts      Local dev runner and the Vercel build.
docs         API and integration guide, strategy and roadmap.
```

The engine runs in both places: the server is the source of truth, and the browser runs the
same code for instant cost and compliance feedback while editing.

## Statutory rates

All UK parameters live in `src/engine/ukRates.ts` and are set for 2026/27. They change every
April and must be checked against GOV.UK before each tax year.

See `docs/STRATEGY.md` for the competitive position, JV model and roadmap.
