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
| People | Employee records: details, employment dates, roles, contract and pay, right to work, availability and leave. Each record is checked before it reaches the rota: right to work missing or expired, pay below the legal minimum, upcoming birthdays that move the minimum wage band, salaried pay that falls below minimum wage at maximum hours, under 18 opt-outs, auto-enrolment eligibility. Starters and leavers are pro-rated in cost, kept off the auto-build outside their dates, and exported for payroll. | `src/engine/employees.ts`, `src/ui/PeopleView.tsx`, `src/ui/EmployeeEditor.tsx` |
| Close | Rota to labour accrual journal by role nominal and site tracking category, exported in Xero manual journal format, plus an hours file for payroll. | `src/engine/journal.ts`, `src/ui/CloseView.tsx` |

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build    # typecheck and production build
```

The demo runs two London sites (Marylebone and Shoreditch) with realistic teams, rates and
forecasts. Press "Build from forecast" to generate the week. Data is held in the browser only.

## Structure

```
src/engine   Pure TypeScript domain logic. No UI, fully unit tested. This is the product.
src/ui       React front end over the engine.
docs         Strategy and roadmap.
```

The engine is deliberately framework-free so it can move server-side unchanged when we add
persistence, multi-user access and integrations.

## Statutory rates

All UK parameters live in `src/engine/ukRates.ts` and are set for 2026/27. They change every
April and must be checked against GOV.UK before each tax year.

See `docs/STRATEGY.md` for the competitive position, JV model and roadmap.
