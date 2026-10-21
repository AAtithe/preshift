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
| Close | Rota to labour accrual journal by role nominal and site tracking category, exported in Xero manual journal format, plus an hours file for payroll. | `src/engine/journal.ts`, `src/ui/CloseView.tsx` |

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build    # typecheck and production build
```

The rota assistant needs a Claude API key on the server. Put it in `.env.local` (git ignored):

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

The browser never sees the key: it calls `/api/anthropic` on the dev or preview server, which adds the
key and forwards to the Claude API (`vite.config.ts`). When the app moves to its own backend, that proxy
moves with it. The assistant uses Claude Opus 5.5 with the server-side refusal fallback enabled.

The demo runs two London sites (Marylebone and Shoreditch) with realistic teams, rates and
forecasts. Press "Build from forecast" to generate the week. Data is held in the browser only.

## Structure

```
src/engine   Pure TypeScript domain logic. No UI, fully unit tested. This is the product.
src/ai       The rota assistant: tools over the engine, and the Claude loop that drives them.
src/ui       React front end over the engine.
docs         Strategy and roadmap.
```

The engine is deliberately framework-free so it can move server-side unchanged when we add
persistence, multi-user access and integrations.

## Statutory rates

All UK parameters live in `src/engine/ukRates.ts` and are set for 2026/27. They change every
April and must be checked against GOV.UK before each tax year.

See `docs/STRATEGY.md` for the competitive position, JV model and roadmap.
