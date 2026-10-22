# Taking a client live

A client is live when their labour % is true every week: real takings in, real hours out, and a
week-end accrual that payroll proves right. This list gets them there. Work it in order. Each step
says who does it and how to tell it is done. Do not skip the sandbox steps to save a day; a wrong
first number costs the client's trust, and that is slower to win back than any day saved.

## Before the first client: once, for Preshift

| Step | Who | Done when |
| --- | --- | --- |
| Turn on "Allow auto-merge" in the repository settings (Settings, General, Pull Requests). | Repository owner | A green pull request merges itself. |
| Register Preshift as a Lightspeed Restaurant (K-Series) app with Lightspeed. Redirect address: `https://<your Preshift address>/v1/integrations/epos/lightspeed/callback`. Set `LIGHTSPEED_CLIENT_ID`, `LIGHTSPEED_CLIENT_SECRET` and `PRESHIFT_PUBLIC_URL` on the server. | Williams, Stanley & Co. | Settings offers "Connect with Lightspeed" instead of saying it is not set up. |
| Apply to Toast for API access as an integration partner, or confirm the client can request standard API access for their own restaurants. | Williams, Stanley & Co. | Toast has issued a sandbox client ID and secret. |
| Create a Square application in the Square Developer Console. | Williams, Stanley & Co. | A sandbox access token works in Settings. |
| Connect live TeamPay for the client (TeamPay keys on the server) and set each company's TeamPay employer. | Williams, Stanley & Co. | The Integrations page shows payroll as Connected, not Simulator. |

## For each client

### 1. Decide who holds settings access

Whoever manages settings can connect or disconnect the till, which opens the whole group's sales
feed. That is the owner, or the WS partner acting for them. Never a GM: a GM syncs takings for their
own site, which needs only the forecast permission there.

Done when: the person is named in the engagement letter and holds settings.manage on the Access tab,
with an authenticator set up.

### 2. Connect the till in its sandbox first

| Till | What the client gives you | Where it goes |
| --- | --- | --- |
| Square | A sandbox access token, then the production one. Needs ORDERS_READ and MERCHANT_PROFILE_READ. | Settings, EPOS, Square |
| Toast | The client ID and secret Toast issued, with orders read for each restaurant. | Settings, EPOS, Toast |
| Lightspeed | Nothing to paste: the account owner signs in at Lightspeed and approves Preshift. | Settings, EPOS, Connect with Lightspeed |

Match each site to its till location. Bring in the last seven days. Then check three days against the
till's own Z read, line by line:

- net sales agree to the penny, after VAT, tips and service charge;
- a refunded order comes off the day it was refunded;
- a late night (sales after midnight) sits on the night it belongs to.

Done when: three days agree. If one does not, stop and send the difference to Preshift before going
to production. The field mapping for Toast and Lightspeed was built from their documentation and has
not yet met a live account; this check is where it is proved.

### 3. Move to the live till and bring in the history

Reconnect with the production credentials. Press "Bring in the last 13 months" and leave it; it
works a fortnight at a time and carries on overnight if the page is closed.

Done when: the Integrations card shows History from a date thirteen months back, and the Labour
trend shows takings for every past week.

### 4. Decide how covers are counted

Staffing rules set by covers an hour need real covers. Toast and Lightspeed send them with each
order; Square does not.

- On Square: import covers from the booking system on the Takings report (OpenTable, ResDiary or
  SevenRooms, trimmed to date, site and guests), or switch those roles to sales an hour.
- Check each site's average spend per head in set-up: it is what covers are estimated from when none
  are recorded.

Done when: the Demand screen shows no "covers are estimated" notice, or the client has agreed in
writing to staff by sales an hour.

### 5. Prove the accrual on a real pay run

Run a normal week: rota, clocking, approval, hours to TeamPay. When the pay run comes back, open
Reports, Payroll accuracy.

Done when: the run is inside 1%. If it is outside, the people listed are where a rate, contract or
pension setting differs between Preshift and payroll. Fix the record, not the journal, and prove it
again on the next run. Do not promise the client a 3-day close until two runs in a row are inside 1%.

### 6. Hand over

Show the GM their Monday routine: Labour trend for last week, Rota vs actual for the week so far,
the Takings report for any day the till missed. Show the finance lead the Payroll accuracy report.

Done when: the GM can say, without help, which site was over target last week and why.
