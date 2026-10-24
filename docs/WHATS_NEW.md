# What's new

One card a week, newest first. The current card also sits at the top of the README; when a new
week starts, move the old card here unchanged and write the new one in the README.

How to write a card:

- One row per change a person would notice. Group by who it is for: GMs, Staff, Finance, Admin, Everyone.
- Say what changed in plain terms, then why it matters to the operator or the P&L. If you cannot
  write the second column, question whether the change was worth shipping.
- End with one test the team can run in the app that week.
- Write the same week as a release in `src/ui/walkthrough.ts`: one step per change worth walking
  through, each with the section it opens, and the week's test. The app offers it to every person,
  live and in the demo, from that Monday. A release can be merged ahead of its week and goes out by
  itself on the day. The tests fail if the README card's week has no release.

## Week of 19 October 2026

First build. See the README for the full card: management bar, Clock in tab with RFID and
geofencing, staff phone app with breaks, payroll per PAYE scheme, Employment Allowance, in-app
access management with forgot password, rest rules that block publication with a manager override
and a four week override trend per site, the redesigned timeline rota with drag and drop and the
rota P&L, HR files, holiday balances, the break check, GDPR, Integrations, the public demo, and CI on
every pull request.
