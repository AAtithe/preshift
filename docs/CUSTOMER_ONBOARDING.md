# Customer onboarding: the process

How a new business goes from sign-up to running its week on Preshift Rota, what the product does at each
point, and what the WS team does around it. Read this before you take your first onboarding call.

## The principle

A customer is not onboarded when their data is loaded. They are onboarded when a GM has built a
week from the forecast, published it to the team, and seen clocked hours and takings come back
against it. Until then they have bought software. After it they have a labour line they control.
Everything below is built to get them to that point inside the 14 day trial, because a trial that
has not published a rota by day 7 rarely converts.

Coaching point for the team: never measure an onboarding by steps ticked. Measure it by the date of
the first published rota and the first week with labour % worked from real takings. Those two dates
are what the customer will remember as "it worked".

## What the product does

Getting started (Organisation, then Getting started) is the customer's own plan. Each step is proved
by their data, never ticked by hand. It sits in `src/engine/golive.ts`, is served at `GET /v1/golive`
to anyone with `settings.manage`, and is read by Shifty (`go_live_plan`) so "what should I do next"
gets a real answer. A one-line banner shows on every screen until they are live.

| Phase | Due by | Step | Proved by |
| --- | --- | --- | --- |
| Secure the account | Day 0 | Authenticator | The owner's authenticator confirmed |
| Set up the business | Day 1 | Companies | Every company has a company number and PAYE reference |
| | Day 1 | Sites | Every site has opening hours and a labour target |
| | Day 2 | Trading week | Every site has a typical week, and staffing rules exist |
| Bring in the team | Day 3 | Team loaded | At least one current person |
| | Day 4 | Records clear | Nobody held off the rota (right to work, minimum wage, date of birth) |
| | Day 5 | Holiday balances | Everyone already working has an opening position (carried over, accrued or taken) |
| | Day 5 | Right to work copies | Every recorded check has a copy of the documents held |
| | Day 5 | Written statements | Everyone has a written statement recorded as issued |
| | Day 4 | Email | The organisation's email is set up |
| | Day 4 | Managers (if it applies) | Another manager invited |
| | Day 5 | Staff app | Half the team signed in to the staff app |
| First rota | Day 5 | Build | Shifts this week or later |
| | Day 7 | Publish | A week published |
| Run the week on it | Day 10 | Takings | Takings on at least 3 of the last 14 days |
| | Day 10 | Clocking | Time clocked |
| | Day 12 (if it applies) | Training | Everyone holds the training their role requires, in date |
| | Day 12 (if it applies) | Payroll | Everyone set up in TeamPay |
| Decide | Day before the trial ends | Subscribe | A subscription in force (self sign-ups only) |

A step past its day reads Late. Optional steps never do, and never hold back going live. Live means
every required step done; the day it first happens is kept, with `golive.live` on the audit trail.

The morning nudge: on the same run as the managers' digest (`/internal/digest`), a self sign-up's owner
gets one email when a step goes late, naming it, why it matters and how to do it. One email per step,
never more than one every two days, nothing once live, and never to a WS client. Sent through the
email of the organisation that runs Preshift Rota, as the sign-up link is. `golive.nudged` on the audit trail.

## Bringing data across

Set-up, Import takes everything across from an Excel workbook (.xlsx or the older .xls) or CSV, in
twelve tabs worked in order: team, managers, right to work, HR file and documents, training, reviews,
holiday balances, TOIL, absences, past hours, takings and the rota ahead. Two routes, and the second
is usually faster:

1. Download the Excel template from that screen. It lists the customer's own roles and sites and
   explains every column. They fill in Team, Holiday balances and Rota, and upload it.
2. Upload the exports from their old rota, HR or payroll system as they are. Columns are matched by
   name. Where a header is not recognised, choose the column by hand or press "Map the columns with
   Shifty". Shifty sees the headers and the kind of value in each column; names, emails, dates of birth,
   NI and phone numbers are masked first.

Order matters: the tabs are numbered in the order to work them, team first and rota last, because
everything else is matched to people already on Preshift Rota. Every import shows a preview and saves
nothing until it is confirmed, and every upload is kept under Recent uploads, where it can be undone:
people added are removed (unless payroll already has them), changes are put back as they were, and
TOIL is reversed by an adjustment. Coaching point: a wrong mapping is a two minute fix, so let the
customer try the upload themselves with you watching, rather than doing it for them.

What each of the less obvious tabs is for:

- Managers: each GM, assistant and director invited by email with their role and sites, as from Access.
  Nobody is made an owner from a file.
- Past hours: the last 17 weeks or more of timesheets or payroll hours. Without them, the 48 hour average,
  night work, guaranteed hours offers and irregular hours holiday accrual all start from nothing on day
  one, and an existing breach stays invisible for months. They were paid by the old payroll, so they are
  stored as already paid and never go to payroll again.
- Takings: at least eight weeks, so the forecast learns how each site trades from the first rota.
- Reviews: probation, appraisals and one-to-ones. Disciplinary, grievance and capability cases are
  never imported: each goes on the file by hand.

Copies never come through a spreadsheet. Right to work checks, signed statements, certificates and
fit notes come across as dates and details; the preview counts the copies still to upload. Coaching
point: a right to work check without a copy of the documents is no statutory excuse, so the day 3
call ends with a list of whose copies are missing and who is uploading them by when.

TOIL is owed pay. Its balance sits beside the holiday pay provision on the Holiday screen, and the weekly
labour accrual posts the TOIL owed at each week end, so the books carry it and the P&L takes the
movement. Ask every customer whether they bank overtime as TOIL; most hospitality operators do
informally, on a spreadsheet nobody reconciles. From go-live, a salaried manager's weeks over contract
are offered on their record to bank as TOIL; an hourly worker's extra hours are already paid through
payroll, so they are never offered, or they would be paid twice.

Holiday and TOIL balances are the ones to get right, because they are balance sheet numbers. Coaching point:
before confirming, pick three people (one fixed hours, one irregular hours, one with carry over) and
check the "Remaining on Preshift Rota" column against the old system's figure. If they agree, the holiday
pay accrual starts from the right place. If they do not, it is almost always a start date, contracted
hours or leave year start that is wrong, and that is worth fixing before payroll relies on it.

## What the team does

The product carries the customer between the touchpoints. The team owns the touchpoints. Customers
(for customer operations) and Clients (for client partners) already flag who needs a call; work from
those, not from memory.

| When | Who | What good looks like |
| --- | --- | --- |
| Day 0, within 2 working hours of sign-up | Customer operations | A 10 minute welcome call. Agree the date of their first published rota, and write it down. Confirm who their payroll is with and which till they use. Do not demo: open Getting started together and do step 1 with them. |
| Day 3 | Customer operations | Check the plan. If the team is not loaded, get their exports on a screen share and run Set-up, Import with them: team, right to work, holiday balances and past hours. Send the staff app invites in one go from Clock in, Phone logins. This is the step most trials die on. |
| Day 7 | Customer operations | The rota review. If published: walk the labour % against target with the GM and show them the Coach. If not: find the blocker, usually records held back for right to work, and fix it on the call. Customers flags "A week in and no rota published": this is that call. |
| Day 10 to 12 | Customer operations | The value call. Show the first week of labour % from real takings, and clocked against rota. Put a pound figure on what they saw. Then ask for the decision. |
| Trial ends in 3 days | Customer operations | Only if not subscribed. Customers flags it. |
| Live | Client partner, where they become a WS client | Hand over to the labour programme (`docs/PROGRAMME.md`): Baseline, Control, Optimise, Embed. |

For WS clients (added from Clients), the client partner runs the same calls on the same days. There
is no trial or nudge: the partner is the nudge.

## How to run a good onboarding call

- Lead with their number, not our features. Ask what labour ran at last month as a share of sales.
  Most operators do not know it to a point. That is the reason to finish onboarding.
- One next step, with a date. Not a list. Getting started shows the next step; say it out loud and
  agree when it will be done.
- Do the hard step with them. Loading the team and clearing right to work records are where trials
  stall. Twenty minutes on a screen share saves the conversion.
- Write it down. Note the agreed first-rota date on the customer's record so the day 7 call checks
  against a commitment, not a hope.

## Where it lives

| Piece | File |
| --- | --- |
| The plan and its rules | `src/engine/golive.ts`, tests in `src/engine/golive.test.ts` |
| The facts, the route and the nudge | `server/golive.ts`, `server/routes/golive.ts`, tests in `server/golive.test.ts` |
| The nudge email | `goLiveNudgeEmail` in `server/mail.ts` |
| The screen and banner | `src/ui/GoLiveView.tsx` |
| Import, template and AI mapping | `src/engine/externalImport.ts`, `src/engine/hrImport.ts`, `src/engine/xlsx.ts`, `src/engine/xls.ts`, `src/engine/importTemplate.ts`, `src/ai/importMapper.ts`, `src/ui/importPlan.ts`, `src/ui/ImportPanel.tsx` |
| Upload batches, undo, past hours, removing a person added in error | `server/routes/imports.ts`, tests in `server/imports.test.ts` |
| TOIL | `src/engine/toil.ts`, `toilLines` in `src/engine/journal.ts`, `src/ui/ToilPanel.tsx`, `POST /v1/employees/:id/toil` |
| Shifty | `go_live_plan` and `open_import` in `src/ai/appTools.ts` |
