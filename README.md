# Preshift Rota

The rota built by finance people who have run hospitality floors. A joint venture between
Williams, Stanley & Co. and [Preshift](https://preshift.co.uk/).

Every rota tool on the market answers "who is working when". Preshift answers the question an
operator actually cares about: "what will this week's labour cost me against what I will take,
and is it legal". It builds the rota from the sales forecast, costs every shift the way payroll
will, blocks anything that breaks UK employment law, and hands finance a ready-to-post labour
accrual so the P&L carries true labour before payroll has even run.

## What is in this first build

| Area | What it does | Where |
| --- | --- | --- |
| Demand-led build | Turns hourly forecast sales and covers into headcount per role (sales per labour hour or covers per person, with floors and caps), then fills the gaps peak-first, cheapest legal person first, and trims overstaffed edges. Gaps it cannot fill legally are reported as a hiring or cross-training signal. | `src/engine/demand.ts`, `src/engine/autoschedule.ts` |
| True cost per shift | Gross pay, holiday accrual (12.07%), employer NI at 15% over the £96 weekly threshold, auto-enrolment pension on qualifying earnings, guaranteed contracted hours. On-costs are worked on the whole week then spread over shifts, so the rota reconciles to payroll. | `src/engine/cost.ts`, `src/engine/ukRates.ts` |
| Marginal cost | The shift editor shows what a shift adds to the week, not a naive rate x hours. Someone on guaranteed hours costs nothing extra; someone already over the NI threshold costs 15% more than the headline rate. | `src/ui/ShiftEditor.tsx` |
| UK compliance | Working Time Regulations breaks, 11 hour daily rest (across week boundaries), weekly rest, 48 hour average without opt-out, young worker limits (8h/day, 40h/week, 30 minute break, 12h rest, night work), minimum wage by age, double booking, leave, availability, training. Blocking issues stop publication. | `src/engine/compliance.ts` |
| Live labour % | Forecast sales, loaded labour, labour % against the site target, pound variance, SPLH, by day and week. | `src/engine/metrics.ts`, `src/ui/KpiBar.tsx` |
| People | Employee records: details, employment dates, roles, contract and pay, right to work with the copies of the documents checked, availability and leave. Each record is checked before it reaches the rota: right to work missing or expired, checked with no copy held or no date recorded, pay below the legal minimum, upcoming birthdays that move the minimum wage band, salaried pay that falls below minimum wage at maximum hours, under 18 opt-outs, auto-enrolment eligibility. Starters and leavers are pro-rated in cost, kept off the auto-build outside their dates, and exported for payroll. | `src/engine/employees.ts`, `src/ui/PeopleView.tsx`, `src/ui/EmployeeEditor.tsx`, `server/routes/documents.ts` |
| Holiday | Entitlement balances per person for each company's leave year: 5.6 weeks (or the contract) earned evenly for fixed hours staff, 12.07% of hours worked for irregular hours staff, from approved clocked time where it exists and the rota otherwise. Taken and booked leave, carry over, opening balances at go-live, and per-day hours. Flags overbooking, unused leave near year end, and leavers' final holiday pay. The untaken balance is valued as the holiday pay provision, with employer NI, to match the balance sheet accrual. | `src/engine/holiday.ts`, `src/ui/HolidayView.tsx` |
| HR | The personnel file behind every person, with everything a GM must act on in one list. Contract type, written statement issued and signed (a day one right), probation dates and outcome, fixed-term end, notice (contract against statutory: a week after a month, then a week a year to twelve), NI number, address, emergency contact and line manager. Sickness and other absence with fit notes after seven days, return to work conversations and the Bradford factor over 52 weeks; disability or pregnancy related absence is kept out of triggers. A shift on an absence day is blocked like leave, and the auto-build steers round it. A training matrix of the certificates an EHO, licensing officer or insurer asks for, required by role (food hygiene, allergens, Challenge 25, personal licence), with expiry warnings. Probation and appraisal tracking, and disciplinary, grievance and capability cases with outcomes and live warnings, visible to admins only. Headcount, turnover, average service and sick days per head across any scope, with directory, absence and training CSVs. Rota and payroll keys never see the file: they get absence dates only, without reasons. Subject access exports include the HR records; contact erasure removes address and emergency contact; anonymisation removes the NI number, sickness reasons and every HR record; the record of processing lists personnel files and health data. | `src/engine/hr.ts`, `server/routes/hr.ts`, `src/ui/HrOverview.tsx`, `src/ui/HrFile.tsx`, `src/ui/AbsenceView.tsx`, `src/ui/TrainingView.tsx`, `src/ui/ReviewsView.tsx` |
| Rota assistant | The GM tells it what they need in plain English ("Ben is off Saturday, re-cover the bar without going over target") and Claude drafts the week by calling the engine's own tools. Every shift it proposes is costed by the payroll model and checked by the compliance engine; anything with a blocking issue is refused, so it cannot roster illegally. The GM sees labour % before and after, the changes, and a short note on gaps and trade-offs, then applies or discards the draft. | `src/ai/rotaTools.ts`, `src/ai/rotaAgent.ts`, `src/ui/AssistantPanel.tsx` |
| Close | Labour accrual journals by role nominal and site tracking category, one per entity, from approved actuals once available, otherwise the rota, exported in Xero manual journal format. | `src/engine/journal.ts`, `src/ui/CloseView.tsx` |
| Multi-site | Group and entity views put every site side by side with entity subtotals and a sales-weighted group target. One press builds every site in scope: each site's own team first, then cover from people who have agreed to work other sites. Cross-site cover is reported each week. | `src/engine/metrics.ts`, `src/engine/autoschedule.ts`, `src/ui/GroupView.tsx` |
| Multi-entity | Sites trade in an entity and people are employed by one, which need not be the same (a central employing company, or cover at a sister company's site). Cost lands where the work was done; the wages accrual stays with the employer; the difference posts as an intercompany recharge on both sides, checked to agree before posting. | `src/engine/types.ts`, `src/engine/journal.ts` |
| Payroll per PAYE scheme | Each company has its own TeamPay employer. Starters, leavers and approved hours go to the scheme of the company that employs the person, wherever they worked; hours go as one batch per company, and each pay run comes back to its company and is reconciled against that company's accrual only. Nothing is sent until every company with hours has an employer, and moving a synced person between schemes is refused because it is a leaver and a starter. | `server/payrollEmployers.ts`, `server/routes/payroll.ts`, `server/outbox.ts` |
| Employment Allowance | One claim per connected group, set on the claiming entity with what the last payroll left unused. Used against that entity's employer NI week by week until it runs out, as payroll applies it, and posted to its books only (Cr employer NI, Dr wages accrual) split across its sites. Resets each tax year. Site labour % stays before the allowance. | `src/engine/allowance.ts`, `src/engine/journal.ts` |
| Reports | Labour trend over 4, 8 or 13 weeks on actual takings, with the target flexed to what each week took, labour from clocked time where a site clocks and the rota where it does not, and weeks over target counted by site. Cost by role: loaded labour by department and role with every on-cost, tying to the KPI bar and each wages nominal in the journal. Rota vs actual: the planned week against the latest estimate (clocked time for days worked, the rota for days left), per person hours and cost variance, shifts not clocked and unrostered clocking. Takings: net sales by site and day from a till feed (`PUT /v1/sales`), keyed in, or imported from the till's CSV export. Payroll accuracy: every pay run's accrual against what payroll cost, runs inside 1%, average miss, reruns replacing earlier runs, and people who miss the same way run after run. Every report exports to CSV and works for a site, an entity or the group. | `src/engine/reports.ts`, `src/ui/ReportsView.tsx`, `src/ui/TakingsEntry.tsx`, `src/ui/PayrollAccuracy.tsx` |
| Integrations | One page under Admin showing every connection and whether it is working: TeamPay per PAYE scheme, Xero journal export, card readers and geofences, the staff app, Claude and Resend keys, and the API. EPOS, Talent Funnel, other ATS and TrustID are shown as not connected yet, each with what it would remove and the live numbers it would fix (sites with a forecast, starters, right to work checks missing or expiring). | `src/ui/IntegrationsView.tsx` |
| API | Fastify REST API with OpenAPI docs at `/docs`, scoped API keys and per-organisation tenancy. The web app runs entirely on it. | `server/` |
| TeamPay, native | Starters, changes and leavers sync to TeamPay as they are saved. Approved clocked hours go to TeamPay through an idempotent, retrying outbox. Signed `payroll.run.completed` webhooks bring the pay run back and reconcile it to the accrual. | `server/integrations/payroll/`, `server/outbox.ts`, `src/ui/PayrollView.tsx` |
| Time and attendance | Clock in and out (UK wall-clock time, overnight shifts), manual entries, manager approval, rota against clock by person, period locking once sent to payroll. | `server/routes/time.ts`, `src/engine/timesheet.ts` |
| Shift sign-in | Clock in tab for a tablet at the site entrance: staff tap an RFID card (USB keyboard reader, or a phone's NFC on Android Chrome) or sign in by name. Each site can have a geofence; signing in by name on a device must happen inside it, and the location is kept on the time entry. Repeat reads of one tap are ignored. | `src/ui/ClockView.tsx`, `server/routes/clocking.ts`, `src/engine/clocking.ts` |
| Staff app | Staff clock in and out on their own phones at `/staff/`, record their breaks, and see their own published shifts and hours. Breaks are not location checked (they only lower paid time); recorded breaks set the entry's unpaid minutes at clock-out, the phone shows the legal minimum for the shift, and a card tap during a break ends the break. A manager sends a one-time invite link from Clock in setup (valid 7 days; a new one resets a forgotten password). Phone clocking needs the site's geofence, both ways. Staff logins are separate from manager accounts and reach nothing else; closing a login or marking a leaver ends it at once. | `src/staff/`, `staff/index.html`, `server/routes/staff.ts` |
| Break check | Finished shifts with less rest break than the Working Time Regulations give (20 minutes in one block over 6 hours of work; 30 over 4.5 hours for under 18s) are flagged on the Payroll tab before approval, as too short or split. A manager can enter a break that was taken but not recorded; nothing is changed automatically, and approval is never blocked but is recorded against the flagged shifts. | `src/engine/breaks.ts`, `src/ui/BreakShortfalls.tsx` |
| How to | Guides for GMs under Help in the management bar, starting with what to do about breaks below the legal minimum. The same steps appear as pop-ups on the Payroll tab: "What do I do?" beside the break flags, and a check before Approve all when flagged shifts are waiting. Add a guide in `src/ui/guides/index.ts`. | `src/ui/HowToView.tsx`, `src/ui/guides/` |
| Drag to move and resize | Drag a shift to another person or day, or drag either edge to change the hours in 15 minute steps. Labour cost, labour %, compliance flags and every chart recalculate live while you drag, and a readout beside the pointer shows the change to the week. Drops on approved leave or outside stated availability are refused with the reason, and resizes stop at the edge of availability (the shift editor remains the place for an agreed exception). On a tablet, press and hold a shift to lift it, so a swipe still scrolls; the edge grips work straight away. The grid scrolls when a shift is held near its edge. A first-use hint explains the gestures. Escape cancels, Undo reverses, and Alt with the arrow keys does the same from the keyboard. | `src/ui/RotaGrid.tsx`, `src/ui/drag.ts` |
| Service timeline | The default rota view. Each day is drawn over its own forecast sales curve, with shifts as bars grouped front of house, bar and back of house, and a strip under each day reading hours short or over against demand. Bars drag along the day, by their ends, or up and down to another day, with the same live costing and leave and availability rules as the person grid, which stays one click away. | `src/ui/Timeline.tsx`, `src/ui/useShiftDrag.ts` |
| Add a shift | On the timeline, drag across empty space on a day to draw a shift, click or tap for a four hour block, or click a red short hour to fill that gap with the role that is shortest. A picker asks who should work it: the site's team ranked trained and clear first, then cheapest, where cost is what the shift adds to that person's loaded week (nothing for guaranteed hours, more for anyone over the NI threshold). Leave, availability, double booking and other blocks are shown with the reason. Hovering a name previews them across the whole page, including the P&L. | `src/ui/assign.ts`, `src/ui/AssignPanel.tsx` |
| Borrow across sites | The picker also offers people from the group's other sites who are set up to cover this one, under their own heading, with the reason anyone cannot take it. Cost is shown twice: what the shift adds to the group, and what it puts on the host site's labour, because cost follows the work. It says when borrowing is cheaper for the group or the only option, flags a same-day shift at another site with under an hour to get across, and rest and hours rules count the person's whole week at every site. Borrowed people are tagged on the timeline and grid. Borrowing follows each person's cover sites from their People record, and anyone employed by another company is marked as an intercompany recharge. Close lists cross-site labour by pair of sites, with a CSV, beside the intercompany recharges the journal books. | `src/ui/assign.ts`, `src/ui/AssignPanel.tsx`, `src/ui/CloseView.tsx` |
| Travel between sites | Each site has a location from its postcode (postcodes.io), and journey times between every pair come from the TfL journey planner for a weekday at 17:00 by public transport or on foot, with times set by hand kept and a labelled straight-line estimate where TfL has no answer. The compliance check blocks a same-day move between sites that cannot be made in time and flags one with less than ten minutes to spare, everywhere: drag, the editor, the picker, the auto-build and the API. Borrowed people in the picker show their journey from their home site. Set postcodes and refresh on the Sites overview. | `src/engine/travel.ts`, `server/routes/travel.ts`, `server/integrations/travel/journeys.ts`, `src/ui/TravelPanel.tsx` |
| Rota P&L | Beside every screen: forecast sales, wages, holiday, employer NI and pension in brackets, labour cost tied to the journal, contribution after labour, labour % against target, day by day, compliance, and sign-off to publish. | `src/ui/PnlRail.tsx` |
| GDPR | UK GDPR for staff data under Admin. A request log for access, erasure, rectification, restriction, portability and objection, with the one calendar month deadline (three when extended) and overdue flags. One-click subject access export of everything held on a person, with how it is used and their rights. Erasure for leavers only, keeping what the law requires (Article 17(3)). A retention schedule that strips clocking locations after 3 months, contact details, card and staff login 3 months after leaving, right to work detail 2 years after leaving, and anonymises the person 6 years after the tax year they left, keeping shifts and pay for the accounts; statutory floors cannot be undercut. An Article 30 record of processing built from what is held, with lawful basis, retention and processors (TeamPay, Anthropic, Resend, hosting), exportable as CSV. Acting on personal data is admin only and audited by id. | `src/engine/gdpr.ts`, `server/routes/privacy.ts`, `src/ui/PrivacyView.tsx` |

## Design

The product is meant to read like management accounts, not like a rota app, in Williams, Stanley & Co. colours: WS navy (#003359) on white over a pale blue gradient, ledger rules and double rules under totals, set in Geist with Geist Mono for figures and labels. Beyond the navy, colour is reserved for money and the law: teal inside budget, coral over budget or blocked, gold to review, each checked for colour-blind separation and always shown with a label or mark. Roles and departments are told apart by position and label, never by colour, so anything coloured on screen is something to act on.

## Running it

```bash
npm install
npm run dev      # API on :8787, web app on http://localhost:5173, API docs on /docs
npm test         # engine, UI rules and API tests (249 across 24 files)
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
  remove people. Members use the app across every site but cannot manage access. Site managers run only
  the sites an admin ticks for them: rota, demand, clocking, people, holiday and HR files for their own staff, and
  rostering of people from other sites who have agreed to cover theirs (seen without contact details or file).
  They enter takings and see reports for their sites, and add and view right to work copies for their own staff.
  Payroll, payroll accuracy, the close, integrations, GDPR, company settings, travel times, document deletion and
  access logs, and disciplinary cases are closed to them. The server
  enforces it three ways: an allowlist of site-level routes (anything not listed, including routes added later, is
  refused), reads cut down to their sites, and a site check on every write (`server/scope.ts`). A change of role or
  sites applies on the person's next request. Every organisation keeps at least one admin, and nobody can remove themselves.
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
makes a 24 hour link with "Reset link" and hands it over.

The demo runs a small group: West End Dining Ltd (Marylebone and Fitzrovia) and East Canteen &
Kitchen Ltd (Shoreditch), with realistic teams, rates and forecasts, against a TeamPay simulator.
A few people cover sister sites, and one Shoreditch bartender covers Marylebone, which is a
cross-company recharge. Choose an entity and site in the top bar, or leave both on "All" for the
group view, and press "Build" to generate the week. The rota assistant and the Payroll tab work on
one site, so they appear once a single site is selected. On the Payroll tab: set people up in
TeamPay, simulate clocking, approve, send hours, run payroll. Set the `TEAMPAY_*` variables to
connect to real TeamPay and `PRESHIFT_DATABASE_URL` for Postgres; see `docs/API.md`, which also
covers the Vercel deployment.

## Public demo for prospects

A second deployment of the same code, with `PRESHIFT_DEMO=1`, is a live demo anyone can use without
an account. The marketing site's "Try the live demo" button opens `/demo`, which gives the visitor
their own private copy of the demo group and signs them in as its admin. Everything works as it
does for a customer: build from forecast, edit shifts, compliance, people, clock in, payroll
against the TeamPay simulator, the Close journals and the API docs.

- Isolation. Each visitor gets a sandbox organisation of their own; nobody sees anyone else's.
  Returning to `/demo` takes them back to theirs; "Start again" gives them a fresh one.
- Guard rails. Accounts, passwords and resets, the Claude key, email settings and owner setup
  cannot be changed. Staff app logins work inside the sandbox. Payroll
  always runs on the simulator, even if `TEAMPAY_*` keys are present. Sandboxes and their visitor
  are deleted after 24 hours (on the daily cron and as new visitors arrive).
- Rota assistant. Off unless `PRESHIFT_DEMO_CLAUDE_KEY` is set, then capped at 40 Claude calls per
  sandbox. Put a monthly spend limit on that key in the Claude Console.
- Where it runs. A separate Vercel project from the same repository, with its own Neon database
  (`PRESHIFT_DATABASE_URL`), never the database that holds customer data. Without a database the
  demo still works on one instance but sandboxes do not survive a cold start. Set `CRON_SECRET` for
  the daily clean-up.
- Linking from the live system. Set `PRESHIFT_DEMO_URL` on the live deployment (for example
  `https://demo.preshift.co.uk/demo`) and its `/demo` sends visitors there.

Locally: `npm run dev:demo`, then open http://localhost:5173/demo.

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

Set `PRESHIFT_DOCUMENT_KEY` (`openssl rand -base64 32`) before anyone uploads a right to work copy.
Copies are encrypted with it and it is never stored in the database; without it, a database
deployment refuses uploads and views. Keep a copy of the key outside Vercel: losing it loses every
stored copy. Every view of a copy is logged, and admins see the log on the employee record.

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
