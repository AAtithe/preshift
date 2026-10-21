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
| Close | Labour accrual journal by role nominal and site tracking category, exported in Xero manual journal format, plus an hours file for payroll. Built from clocked hours for days that have traded and the rota for the rest, or from the rota alone. | `src/engine/journal.ts`, `src/ui/CloseView.tsx` |

## The actuals loop

The rota is a plan. The money is in the gap between the plan and what payroll pays, and this is
where that gap is caught, explained and closed every day rather than found at month end.

| Area | What it does | Where |
| --- | --- | --- |
| Clocking | Geofenced clock-in against the rostered shift, no earlier than 10 minutes before the start. Unrostered clock-ins are allowed and held for approval. Time is never rounded: what is clocked is what is paid, which keeps the site safe on minimum wage. | `src/engine/clocking.ts` |
| Cut call | Trading so far against forecast gives the pace. The rest of the day is reforecast at that pace and turned back into headcount, and the GM is told who to send home and when, dearest saving first. Savings are worked on the person's whole week, so someone inside their guaranteed hours saves nothing and stays. Hours that are now short are flagged. | `src/engine/cutcall.ts`, `src/ui/LiveView.tsx` |
| Rota to payroll variance | Every closed day, rota against clock, classified by cause (early clock-ins, overruns, breaks not taken, unrostered shifts, late arrivals, early finishes, no-shows), costed at the loaded marginal rate and reconciled to the cost engine. The remainder is the guaranteed hours and threshold effect, shown on its own line. | `src/engine/actuals.ts` |
| Approval | Every extra paid minute waits for a manager's sign-off before payroll, largest first. | `src/ui/ActualsView.tsx` |
| Labour flash | Actual sales, clocked labour, actual labour % against target by day, closed days only, so a mid-week flash is never flattered by days not yet traded. | `src/engine/actuals.ts` |
| Clocked compliance | Working Time and young worker checks run on clocked hours. A legal rota can produce an illegal week: an overrun pushes a 6 hour shift past the break threshold, a skipped break, a week over 48 hours. | `src/engine/actuals.ts` |

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build    # typecheck and production build
```

The demo runs two London sites (Marylebone and Shoreditch) with realistic teams, rates and
forecasts. Last week and this week are built from forecast and traded through to 18:00 today, with
the habits that open the gap on a real floor: early clock-ins, closers running over, skipped
breaks, the odd no-show and an unrostered shift. Today is trading slowly so there is a cut call to
make. Data is held in the browser only; "Reset demo" regenerates it.

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
