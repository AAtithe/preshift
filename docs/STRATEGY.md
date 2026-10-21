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

Phase 1, now: this build. Engine, costing, compliance, forecast build, accrual journal.

Phase 2, first live sites (8 to 10 weeks):
- Persistence and auth (Postgres, per-organisation tenancy, roles for owner, GM, finance, staff).
- Staff mobile app: see rota, swap shifts, set availability, request leave, clock in.
- Time and attendance with geofenced clocking, so actual hours replace rostered hours in the
  accrual and the rota-to-actual variance is reported daily.
- Live sales feed from Preshift Reports so labour % updates through the day.
- Payroll exports for the payrolls WS clients run.

Phase 3:
- Forecasting model trained on each site's actuals, weather and local events.
- Tronc and tips allocation under the Employment (Allocation of Tips) Act 2023, with the
  troncmaster audit trail.
- 17 week WTR reference period tracking, holiday entitlement balances, right to work checks.
- Group view across sites with cross-site cover and labour benchmarks across the WS client
  base (anonymised), which no single-vendor tool can offer.

## Metrics that prove it works

- Rota-to-payroll variance under 1% of labour cost.
- Labour % within 1 point of target in 80% of weeks.
- Close completed in 3 working days for sites on Preshift.
- Hours scheduled outside demand (overstaffed hours) down 30% in the first quarter.
