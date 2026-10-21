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
| Drag to move and resize | Drag a shift to another person or day, or drag either edge to change the hours in 15 minute steps. Labour cost, labour %, compliance flags and every chart recalculate live while you drag, and a readout beside the pointer shows the change to the week. Drops on approved leave or outside stated availability are refused with the reason, and resizes stop at the edge of availability (the shift editor remains the place for an agreed exception). On a tablet, press and hold a shift to lift it, so a swipe still scrolls; the edge grips work straight away. The grid scrolls when a shift is held near its edge. A first-use hint explains the gestures. Escape cancels, Undo reverses, and Alt with the arrow keys does the same from the keyboard. | `src/ui/RotaGrid.tsx`, `src/ui/drag.ts` |
| UK compliance | Working Time Regulations breaks, 11 hour daily rest (across week boundaries), weekly rest, 48 hour average without opt-out, young worker limits (8h/day, 40h/week, 30 minute break, 12h rest, night work), minimum wage by age, double booking, leave, availability, training. Blocking issues stop publication. | `src/engine/compliance.ts` |
| Service timeline | The default rota view. Each day is drawn over its own forecast sales curve, with shifts as bars grouped front of house, bar and back of house, and a strip under each day reading hours short or over against demand. Bars drag along the day, by their ends, or up and down to another day, with the same live costing and leave and availability rules as the person grid, which stays one click away. | `src/ui/Timeline.tsx`, `src/ui/useShiftDrag.ts` |
| Add a shift | On the timeline, drag across empty space on a day to draw a shift, click or tap for a four hour block, or click a red short hour to fill that gap with the role that is shortest. A picker asks who should work it: the site's team ranked trained and clear first, then cheapest, where cost is what the shift adds to that person's loaded week (nothing for guaranteed hours, more for anyone over the NI threshold). Leave, availability, double booking and other blocks are shown with the reason. Hovering a name previews them across the whole page, including the P&L. | `src/ui/assign.ts`, `src/ui/AssignPanel.tsx` |
| Rota P&L | Beside every screen: forecast sales, wages, holiday, employer NI and pension in brackets, labour cost tied to the journal, contribution after labour, labour % against target, day by day, compliance, and sign-off to publish. | `src/ui/PnlRail.tsx` |
| Live labour % | Forecast sales, loaded labour, labour % against the site target, pound variance, SPLH, by day and week. | `src/engine/metrics.ts`, `src/ui/PnlRail.tsx` |
| Close | Rota to labour accrual journal by role nominal and site tracking category, exported in Xero manual journal format, plus an hours file for payroll. | `src/engine/journal.ts`, `src/ui/CloseView.tsx` |

## Design

The product is meant to read like management accounts, not like a rota app, in Williams, Stanley & Co. colours: WS navy (#003359) on white over a pale blue gradient, ledger rules and double rules under totals, set in Geist with Geist Mono for figures and labels. Beyond the navy, colour is reserved for money and the law: teal inside budget, coral over budget or blocked, gold to review, each checked for colour-blind separation and always shown with a label or mark. Roles and departments are told apart by position and label, never by colour, so anything coloured on screen is something to act on.

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
