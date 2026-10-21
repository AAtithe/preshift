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
| Rota assistant | The GM tells it what they need in plain English ("Ben is off Saturday, re-cover the bar without going over target") and Claude drafts the week by calling the engine's own tools. Every shift it proposes is costed by the payroll model and checked by the compliance engine; anything with a blocking issue is refused, so it cannot roster illegally. The GM sees labour % before and after, the changes, and a short note on gaps and trade-offs, then applies or discards the draft. | `src/ai/rotaTools.ts`, `src/ai/rotaAgent.ts`, `src/ui/AssistantPanel.tsx` |
| Close | Labour accrual journals by role nominal and site tracking category, one per entity, from approved actuals once available, otherwise the rota, exported in Xero manual journal format. | `src/engine/journal.ts`, `src/ui/CloseView.tsx` |
| Multi-site | Group and entity views put every site side by side with entity subtotals and a sales-weighted group target. One press builds every site in scope: each site's own team first, then cover from people who have agreed to work other sites. Cross-site cover is reported each week. | `src/engine/metrics.ts`, `src/engine/autoschedule.ts`, `src/ui/GroupView.tsx` |
| Multi-entity | Sites trade in an entity and people are employed by one, which need not be the same (a central employing company, or cover at a sister company's site). Cost lands where the work was done; the wages accrual stays with the employer; the difference posts as an intercompany recharge on both sides, checked to agree before posting. | `src/engine/types.ts`, `src/engine/journal.ts` |
| Employment Allowance | One claim per connected group, set on the claiming entity with what the last payroll left unused. Used against that entity's employer NI week by week until it runs out, as payroll applies it, and posted to its books only (Cr employer NI, Dr wages accrual) split across its sites. Resets each tax year. Site labour % stays before the allowance. | `src/engine/allowance.ts`, `src/engine/journal.ts` |
| API | Fastify REST API with OpenAPI docs at `/docs`, scoped API keys and per-organisation tenancy. The web app runs entirely on it. | `server/` |
| TeamPay, native | Starters, changes and leavers sync to TeamPay as they are saved. Approved clocked hours go to TeamPay through an idempotent, retrying outbox. Signed `payroll.run.completed` webhooks bring the pay run back and reconcile it to the accrual. | `server/integrations/payroll/`, `server/outbox.ts`, `src/ui/PayrollView.tsx` |
| Time and attendance | Clock in and out (UK wall-clock time, overnight shifts), manual entries, manager approval, rota against clock by person, period locking once sent to payroll. | `server/routes/time.ts`, `src/engine/timesheet.ts` |

## Running it

```bash
npm install
npm run dev      # API on :8787, web app on http://localhost:5173, API docs on /docs
npm test         # engine and API tests
npm run build    # typecheck and production build
```

The rota assistant needs a Claude API key on the server. Put it in `.env.local` (git ignored):

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

The browser never sees the key: it calls `/api/anthropic` on the dev or preview server, which adds the
key and forwards to the Claude API (`vite.config.ts`). When the app moves to its own backend, that proxy
moves with it. On Vercel the same route is served by `api/anthropic/v1/messages.js`; set
`ANTHROPIC_API_KEY` in the Vercel project's environment variables to switch the assistant on. That
function only forwards the assistant's own requests (one model, capped output) from signed-in users.
Keep a monthly spend limit on the key in the Claude Console all the same. The assistant uses Claude Opus 5.5 with the server-side refusal fallback enabled.

## Sign in

The app and the rota assistant sit behind an email and password sign-in. Until the app has a database,
users are listed in the `APP_USERS` environment variable as hashed passwords; nobody's password is
stored anywhere in plain text. To add a person:

```bash
npm run hash-password -- name@example.com [orgId]   # asks for the password, at least 12 characters
```

The organisation defaults to `demo`; each person only ever sees their own organisation's data.
Add the printed line to `APP_USERS` (several people separated by commas). In production also set
`SESSION_SECRET` to a random string of at least 32 characters (`openssl rand -hex 32`); changing it
signs everyone out. Without both, the live app stays locked. To remove someone, delete their line.

Sessions last 12 hours in an HttpOnly cookie, and the session is what the web app uses to call the
API: the browser carries no API key in production. On Vercel the app's files sit inside a gate
function (`server/appGate.ts`) rather than in public static output, so nothing under `/app` is served
without a session; the API and the assistant check the session themselves. Locally, sign-in is off
unless `APP_USERS` is set in `.env.local`, and the web app uses the local API's development key. Known limits until Phase 2: no self-service password reset, no
roles, and failed attempts are slowed but not locked out.

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
| `/login` | Sign-in page, from `site/login.html` |
| `/app/` | Web app, served only to signed-in users by the gate function (`server/appGate.ts`) |
| `/api/auth/login`, `/logout`, `/me` | Sign-in functions, from `api/auth/*.js` (need `APP_USERS` and `SESSION_SECRET`) |
| `/v1`, `/docs`, `/health` | The API, bundled into one Node function from `server/vercel.ts` |
| `/api/anthropic/v1/messages` | Rota assistant proxy, from `api/anthropic/v1/messages.js` (needs `ANTHROPIC_API_KEY`) |
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
server       The Preshift API and sign-in: routes, API keys and sessions, tenancy, Postgres store, payroll outbox, TeamPay client and simulator.
src/ui       React web app, a client of the API.
site         Marketing site (static, no build step).
api          Web handlers for sign in, sign out and the assistant's route to Claude.
scripts      Local dev runner, the Vercel build and the password hasher.
docs         API and integration guide, strategy and roadmap.
```

The engine runs in both places: the server is the source of truth, and the browser runs the
same code for instant cost and compliance feedback while editing.

## Statutory rates

All UK parameters live in `src/engine/ukRates.ts` and are set for 2026/27. They change every
April and must be checked against GOV.UK before each tax year.

See `docs/STRATEGY.md` for the competitive position, JV model and roadmap.
