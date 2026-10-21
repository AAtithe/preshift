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

## Compliance priced

Incumbents show a red triangle. This puts a pound figure on the breach, the way HMRC, the Home
Office or a tribunal would, because the firm that signs the accounts is the one explaining it.

| Area | What it does | Where |
| --- | --- | --- |
| Minimum wage on hours worked | Test over each person's own pay reference period (the week for weekly pay, the calendar month for monthly pay) on clocked hours, projected at the person's daily rate past the end of the rota, with deductions for the employer's benefit and salary sacrifice taken off. Arrears, the HMRC penalty ceiling (200% of arrears, capped at £20,000 per worker), arrears over a year if the pattern holds, and headroom: how many more hours a salaried person can work before pay drops below the band. The rota warns before a salaried week breaches. | `src/engine/nmw.ts` |
| Right to work | Check on file, permission expiry, and student term-time hour limits with vacations. The rota blocks a shift after permission ends or a student week over the limit, warns inside 2 hours of it because clocked hours decide the breach, and the auto-build keeps that buffer. Priced at the Home Office civil penalty ceiling per illegal worker (£45,000 first breach, £60,000 repeat). | `src/engine/compliance.ts` |
| Working Time | Breaches on clocked hours are listed and counted, not priced: there is no tariff and a tribunal sets compensation case by case. The 48 hour limit is tested as the law sets it, an average over 17 weeks, with the hours a person can still average for the rest of the period. | `src/engine/actuals.ts`, `src/engine/wtr.ts` |
| Tips | Tips past the Act's deadline counted as owed to staff, with the tribunal award ceiling per worker, and the National Insurance a year that rests on the troncmaster genuinely deciding the allocation. | `src/engine/exposure.ts` |
| Employment Rights Act 2025 | On stated assumptions, because the regulations that set the numbers have not been made: who would be owed a guaranteed hours offer on hours regularly worked and what that turns into fixed cost each week, compensation on short-notice cuts, and a cut call that prices it in. | `src/engine/era.ts`, `src/engine/cutcall.ts` |
| Exposure register | All of the above per site and week: owed to staff now, penalty ceiling, annualised arrears, unpriced breaches, and the Employment Rights Act scenario. | `src/engine/exposure.ts`, `src/ui/RiskView.tsx` |

Penalties are ceilings, not predictions. Regulators reduce them for prompt disclosure, which is
why finding the breach first is worth more than the penalty.

## Tronc

Tips and service charge, run the way the Employment (Allocation of Tips) Act 2023 and HMRC
expect, by the firm that also runs the payroll.

| Area | What it does | Where |
| --- | --- | --- |
| Allocation | The week's pool (service charge, card tips, pooled cash) split on clocked hours times points per role, after an optional department split. Departments that did not work have their share passed to those that did, and pennies go to the largest remainders, so every penny taken is passed on. Tips with no clocked hours to go to are held for the next run, never kept. | `src/engine/tronc.ts` |
| Tax | National Insurance worked on each person's whole week of pay, so the saving from an independent troncmaster is the real figure, employer and staff, not 15% of the pool. VAT taken out of a mandatory service charge. | `src/engine/tronc.ts` |
| The Act | Written policy, review with staff, every penny passed on, payment by the end of the month after the tips were taken, a scheme with no gaps in its department split, and a twelve-week tips record for any worker who asks. | `src/engine/tronc.ts`, `src/ui/TroncView.tsx` |
| Payroll | Allocation file with the NI treatment for each payment, and a mark-paid step that clears the deadline. | `src/ui/TroncView.tsx` |

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
make. Salaried managers work the long weeks they do in practice, one of them on a salary that does
not cover the hours; a student was hand-rostered to the full term-time limit last week and an
overrun took them over it; a visa at Shoreditch runs out next week. Marylebone runs an
independent tronc with a discretionary service charge; Shoreditch has the GM deciding the
allocation, a mandatory charge and no written policy. Data is held in the browser only; "Reset demo" regenerates it.

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
