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
| Close | Labour accrual journal by role nominal and site tracking category, from approved actuals once available, otherwise the rota, exported in Xero manual journal format. | `src/engine/journal.ts`, `src/ui/CloseView.tsx` |
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

The demo runs two London sites (Marylebone and Shoreditch) with realistic teams, rates and
forecasts, against a TeamPay simulator. Press "Build from forecast", then work through the
Payroll tab: set people up in TeamPay, simulate clocking, approve, send hours, run payroll.
Set the `TEAMPAY_*` variables to connect to real TeamPay; see `docs/API.md`.

## Deployment (Vercel)

`npm run build:vercel` (set in `vercel.json`) writes `.vercel/output` with the Build Output API:

| Path | What |
| --- | --- |
| `/` | Marketing site, from `site/` |
| `/app/` | Web app |
| `/v1`, `/docs`, `/health` | The API, bundled into one Node function from `server/vercel.ts` |

The hosted API keeps data in memory, so it resets when the function cold starts and is not
shared between instances. That is fine for the demo and not for customers: Postgres is the
Phase 2 store. With no `PRESHIFT_API_KEYS` set it accepts the public demo key the web app ships
with; set `PRESHIFT_API_KEYS` in Vercel before any real data goes in.

## Structure

```
src/engine   Pure TypeScript domain logic, shared by API and browser. Fully unit tested.
server       The Preshift API: routes, auth, tenancy, payroll outbox, TeamPay client and simulator.
src/ui       React web app, a client of the API.
site         Marketing site (static, no build step).
docs         API and integration guide, strategy and roadmap.
```

The engine runs in both places: the server is the source of truth, and the browser runs the
same code for instant cost and compliance feedback while editing.

## Statutory rates

All UK parameters live in `src/engine/ukRates.ts` and are set for 2026/27. They change every
April and must be checked against GOV.UK before each tax year.

See `docs/STRATEGY.md` for the competitive position, JV model and roadmap.
