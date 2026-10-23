# Follow-ups: HR, pay approval and sickness data

Work through this list in order. The software is built. What is left for people is marked "You". Tick each box when it is done, and record the date.

## 1. Actions for the business (owner: you)

- [ ] Appoint a finance director in Access on every live client account. Check this first: Pay approvals warns "Nobody can approve pay" until one exists.
- [ ] Make sure each finance director sets up their authenticator on day one. Until they do, every pay change waits. The Access overview lists them under "Must enrol".
- [ ] Get the sickness appropriate policy document reviewed by employment or data protection counsel. The draft is at https://claude.ai/artifact/WmE4HQPUkKDoZx1egMzhAn.
- [ ] Have a director sign the document for each employing company. Record the review and the signature under Organisation, GDPR, Appropriate policy document. The flag clears when both are recorded.
- [ ] Put the yearly review of the policy document in the diary. Preshift flags it once it passes the review date.
- [ ] Adopt the pay approval rule (2 working days, Monday cut-off) at Williams, Stanley & Co. and send it to clients. The draft is at https://claude.ai/artifact/YLmrec5FcKUMZYEnHdsiRA.
- [ ] Set each client's turnaround and cut-off day under Pay approvals, Change the rule, where they differ from the defaults.
- [ ] Set up email under Settings on every live account, so the morning reminder reaches finance. Without it nothing is sent.
- [ ] Confirm with TeamPay that its API takes the new `sickness` and `adjustments` fields on hours batches, and returns `ssp` per person on pay runs. Until it does, the SSP check stays empty and back pay has to be keyed in TeamPay by hand. See docs/API.md, "What must be confirmed with the TeamPay API reference".
- [ ] Before relying on the SSP estimate, check the April 2026 rules against GOV.UK: no waiting days, no lower earnings limit, the lower of £123.25 a week or 80% of average weekly earnings. Secondary sources disagree on whether a period of sickness still needs 4 days in a row. Preshift pays from day one.

## 2. What was built, and how to check it

| # | Item | Where to check | Done |
| --- | --- | --- | --- |
| 1 | Warning when nobody can approve pay, or the only approver has no authenticator | Hours and pay, Pay approvals: banner at the top | [x] |
| 2 | Demo finance director (Nadia Rahman) has an authenticator | Demo: act as Nadia, approve a change | [x] |
| 3 | Appropriate policy document per company: reviewer, director signature, review date, flag when missing | Organisation, GDPR | [x] |
| 4 | Pay approval rule: turnaround in working days, payroll cut-off day, decide-by date per change | Pay approvals: the rule line and the Decide by column | [x] |
| 5 | Pay changes dated from when they were agreed; back pay sent to payroll with the next hours | Staff, edit a person, Agreed from; Pay approvals, Back pay | [x] |
| 6 | Full cost of each change: holiday, employer NI and pension on top of gross | Pay approvals: A year column (hover for the split) and the KPI | [x] |
| 7 | Morning email to finance; owner copied in when overdue or the cut-off is a day away; Remind finance now button | Pay approvals | [x] |
| 8 | Every change to pay on one history, including system and no-approver changes | Pay approvals: Pay history | [x] |
| 9 | Copies on HR records: contracts, letters, fit notes, certificates, encrypted with every view logged | HR file: Attach a copy under any record | [x] |
| 10 | SSP estimate per sickness spell; sent to payroll; each pay run checked against it | People, Absence: Statutory sick pay; Reports, Payroll accuracy | [x] |
| 11 | Bradford factor on working days from each person's rota pattern | People, Absence: Bradford factor | [x] |
| 12 | Browser test: propose, approve, pay updated | `npm run test:e2e` (local only) | [x] |

## 3. April 2027 minimum wage uprating (built)

- [ ] When the government announces the April 2027 rates (normally late November), enter them under Pay approvals, Minimum wage from 1 April 2027. Check them against GOV.UK first.
- [ ] Choose whether to lift people to the new rate or keep the gap for those just above the old one. Preview the cost, then propose the rises.
- [ ] Have finance approve the batch by mid March, so it is settled before April's first payroll.
- [ ] Put right by hand any salaried person the preview flags as below the new minimum on their maximum hours.
- [ ] Update `src/engine/ukRates.ts` with the 2027/28 rates before 6 April 2027. The checks on each record, the rota costing and the SSP rate still read 2026/27 until then.

## 4. Still open in the product

- [ ] A pay cut approved late does not claw back an overpayment. Decide the policy, then build it if wanted.
- [ ] The SSP estimate uses rostered hours for average weekly earnings. Once TeamPay returns NI-liable pay per run, switch to that.
- [ ] HR record copies can be added in the app, but deleting one is API only (privacy.manage). Add a delete button to the HR file if it is needed.
