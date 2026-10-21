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

The rota assistant needs a Claude API key on the server. Put it in `.env.local` (git ignored):

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

The browser never sees the key: it calls `/api/anthropic` on the dev or preview server, which adds the
key and forwards to the Claude API (`vite.config.ts`). When the app moves to its own backend, that proxy
moves with it. On Vercel the same route is served by the Preshift API function
(`server/routes/anthropic.ts`); set `ANTHROPIC_API_KEY` in the Vercel project's environment variables
to switch the assistant on. That route only forwards the assistant's own requests (one model, capped output), but until the app has
logins anyone who can open /app can spend against the key, so put a monthly spend limit on it in the
Claude Console. The assistant uses Claude Opus 5.5 with the server-side refusal fallback enabled.

The demo runs two London sites (Marylebone and Shoreditch) with realistic teams, rates and
forecasts, against a TeamPay simulator. Press "Build from forecast", then work through the
Payroll tab: set people up in TeamPay, simulate clocking, approve, send hours, run payroll.
Set the `TEAMPAY_*` variables to connect to real TeamPay and `PRESHIFT_DATABASE_URL` for
Postgres; see `docs/API.md`, which also covers the Vercel deployment.

## Structure

```
src/engine   Pure TypeScript domain logic, shared by API, browser and assistant. Fully unit tested.
src/ai       The rota assistant: tools over the engine, and the Claude loop that drives them.
server       The Preshift API: routes, auth, tenancy, Postgres store, payroll outbox, TeamPay client and simulator.
src/ui       React web app, a client of the API.
site         Marketing site.
scripts      Local dev runner and the Vercel build.
docs         API and integration guide, strategy and roadmap.
```

The engine runs in both places: the server is the source of truth, and the browser runs the
same code for instant cost and compliance feedback while editing.

## Statutory rates

All UK parameters live in `src/engine/ukRates.ts` and are set for 2026/27. They change every
April and must be checked against GOV.UK before each tax year.

See `docs/STRATEGY.md` for the competitive position, JV model and roadmap.
