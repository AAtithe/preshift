# Preshift Rota: strategy

## The thesis

Rota software is sold to operations and judged by operations. The money it controls is
reported by finance, weeks later, in a different system. That gap is where margin leaks:
the rota says 26%, the P&L says 31%, and nobody can explain the five points because the two
systems never shared a definition of cost.

Preshift closes the gap. One cost model, used to build the rota, to show the GM the
consequence of every shift, and to post the accrual to the ledger. Williams, Stanley & Co.
brings the finance engine and the close; Preshift brings the data feeds (sales, covers,
weather, footfall) and the operator relationships. Neither can build this alone as credibly.

## Where the incumbents are weak

These are the positioning claims to validate in the first ten customer conversations, not
established facts. Treat each as a hypothesis.

| | Fourth | Workforce.com | Sona | Preshift |
| --- | --- | --- | --- | --- |
| Primary buyer | Enterprise HR / ops | Ops, multi-site | Frontline ops | Owner, GM and finance together |
| Cost shown on rota | Rate x hours, on-costs often estimated | Rate x hours plus configurable on-costs | Rate x hours | Fully loaded, reconciled to payroll, marginal cost per shift |
| Forecast-led build | Available, heavy to configure | Available | Limited | Built in, from Preshift's own sales and covers feeds |
| Ledger integration | Payroll export | Payroll | Payroll export | Labour accrual journal for a 3-day close |
| Setup | Months, consultancy-led | Weeks | Fast | Done for you by WS and Preshift onboarding |
| Price point | High | Mid | Mid | Bundled with WS service or Preshift Core |

The wedge is not "better scheduling". Scheduling is a commodity. The wedge is that the rota
is the first document in the month-end close, and only an accounting firm can make that true.

## Why this wins

1. Distribution. WS clients and Preshift clients are already the target market. The first
   50 sites are a conversion problem, not an acquisition problem.
2. Switching cost runs the other way. Once the rota posts the accrual and the variance to
   payroll is reviewed every week, removing it breaks the close.
3. Data. Preshift already pulls sales and covers. Forecast accuracy improves with every week
   of actuals, and incumbents have to integrate for what we own.
4. Credibility. A labour % number signed off by the firm that produces the management
   accounts is worth more than one from a scheduling vendor.

## JV shape to decide

These are decisions for the founders, with the trade-offs.

- Entity. A NewCo jointly owned is cleanest for IP, investment and an eventual sale.
  A contractual JV is faster but leaves IP ownership ambiguous; avoid it if the product is
  meant to be sold separately.
- IP. The engine (`src/engine`) should sit in the NewCo from day one. Assign it now while it
  is small.
- Revenue. Two routes to market: bundled into WS fees (raises WS price per client, protects
  retention) and sold standalone by Preshift (per site per month). Agree the transfer price
  for bundled sales up front or the partners will argue about it at the first board.
- Data. Client data processing roles need to be clear under UK GDPR before the first live
  site: who is controller, who is processor, and the DPA between the three parties.

## Roadmap

Phase 1, done: engine, costing, compliance, forecast build, accrual journal.

Phase 1b, done: the actuals loop. Geofenced clocking against the rota, the cut call on live
trading pace, rota-to-payroll variance by cause with manager approval, the labour flash on closed
days, Working Time checks on clocked hours, and the accrual built from clocked hours. Engine and
UI only; the clock-ins and sales are simulated in the demo.

Phase 1c, done: compliance priced. Minimum wage on clocked hours with arrears, penalty ceiling
and headroom; right to work with student term-time limits and expiry; Working Time breaches on
clocked hours; the Employment Rights Act 2025 zero and low hours measures on stated assumptions
until the regulations are made; an exposure register per site and week.

Phase 1d, done: tronc. Allocation on clocked hours and points with department splits, every
penny passed on, NI saving from an independent troncmaster on each person's whole week, VAT on a
mandatory service charge, the Act's policy, review, deadline and tips record requirements.

Phase 1e, done: compliance pricing deepened. Monthly pay reference periods, the 48 hour limit
as a 17 week average, and tips owed and NI at stake in the risk register.

Phase 1f, done: the benchmark method. Nine measures per fully traded week from the same engines
as the flash, an anonymous contribution record, peer groups with a minimum of 5 sites from 3
businesses, quartile position and pounds to the median. Runs on an illustrative panel until real
contributions are collected.

Phase 1g, done: retention scoring. Nine transparent signals from clocked hours, early finishes,
Working Time, closes, tenure and pay; replacement cost per person on stated assumptions; the
share of risk the rota drives; no protected characteristics read.

Phase 2, first live sites (8 to 10 weeks):
- Persistence and auth (Postgres, per-organisation tenancy, roles for owner, GM, finance, staff).
- Staff mobile app: see rota, swap shifts, set availability, request leave, clock in with the
  device's location against the clocking rules already in the engine.
- Live sales feed from Preshift Reports into the hourly actuals, so the cut call and labour %
  run on real trading through the day.
- Payroll exports for the payrolls WS clients run, carrying approved clocked hours only.
- The salaried hours work annual calculation, so the minimum wage test for salaried staff
  matches HMRC's method over the year, not only each pay period.
- Replace the Employment Rights Act assumptions with the regulations as each part commences.

Phase 3:
- Forecasting model trained on each site's actuals, weather and local events.
- Tronc audit trail: who changed the scheme and when, troncmaster sign-off of each run, and the
  three year record the Act requires, held server-side.
- Holiday entitlement balances, right to work document capture and Home Office online share code checks.
- Retention: record leavers and reasons, then recalibrate the signal points against who actually
  left; add the benchmark's turnover rate per 100 staff by concept.
- Benchmark service: collect contributions server-side under signed data sharing terms, replace
  the illustrative panel, add trend over time and suppression checks on every published cut.
- Group view across sites with cross-site cover.

## Metrics that prove it works

- Rota-to-payroll variance under 1% of labour cost.
- Labour % within 1 point of target in 80% of weeks.
- Close completed in 3 working days for sites on Preshift.
- Hours scheduled outside demand (overstaffed hours) down 30% in the first quarter.
