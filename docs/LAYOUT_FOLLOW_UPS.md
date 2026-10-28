# Follow-ups: the calmer rota screen, after a full browser check

Checked on 27 October 2026, against main after pull request #127. Work through the list in order. Tick each box when it is done, and record the date.

## How it was checked

- **Owner.** Every section the management bar offers was opened, at one site and across all sites: 109 screens on a desktop (1440px) and a phone (390px).
- **Roles.** The same screens were opened again as five real roles: the Marylebone GM (desktop and phone), a floor supervisor, the finance director and a WS client partner.
- **Detectors.** On every screen the check recorded page errors, failed API calls, sideways overflow, text reading `undefined`, `NaN` or `Invalid Date`, buttons with no name, screens stuck loading and small tap targets on a phone. Every screenshot was then read by eye.
- **Flows.** These were clicked through as the GM:
  - building the week, opening a shift, adding one and publishing;
  - every rota view, Simple, Standard and Expert;
  - an empty future week and a past week;
  - Go to, Shifty and the command bar;
  - the phone menu and the account menu;
  - all 13 cards of What's new;
  - the staff app and the kiosk.

**What passed.** No screen threw a page error, showed `undefined` or `NaN`, or failed an API call for a real role. Building, publishing, the decisions bar updating after a build, every rota view, the density switch, Go to, the phone menu, What's new, the staff app and the kiosk all worked.

## 1. Bugs: fix first

All fixed on 27 October 2026. The changes are noted on each item.

- [x] **Decisions bar on past weeks.** A finished week still says "2 blocking issues stop this week being published" and "1 person is below contracted hours", which nobody can act on.
  - Where: Rota at Marylebone, week of 12 October.
  - Fix: `weekBrief` in `src/engine/decisions.ts` should return no decisions once every day of the week is before today. A unit test should cover it.
  - Done: a week whose days are all past returns no decisions. A unit test and a browser check cover it.
- [x] **Shift editor and person editor.** Neither dialog has a name for screen readers or closes on Escape. Clicking outside either closes it and throws away unsaved edits without asking. The "Add a shift" picker already handles Escape correctly.
  - Where: `src/ui/ShiftEditor.tsx`, `src/ui/EmployeeEditor.tsx`.
  - Done when: both dialogs carry a name, Escape closes them, and closing with unsaved changes asks first.
  - Done: both are named for screen readers and close on Escape. Escape, Cancel or a click outside asks "Close without saving your changes?" when something has changed (`src/ui/useDialogClose.ts`). A browser check covers it.
- [x] **Sideways scroll on a phone.** Five screens are wider than the phone, so the page slides left and right.
  - Clock in: the clock cards, 33px too wide.
  - Reports: the day pills, 79 to 164px.
  - GDPR: four KPI columns, 185px.
  - Your profile: the settings card, 20px.
  - Integrations: 8px.
  - Done when: each screen fits at 390px with no page scroll.
  - Done: Clock in, GDPR and Integrations set their single grid column to `minmax(0, 1fr)`. GDPR's tables scroll inside their cards. The Reports tab bar wraps. Your profile only overflowed for the dev account. A browser check opens every section at 390px.
- [x] **"Build the empty days" does more than it says.** It fills every short hour in the rest of the week, including days that already have shifts. On Marylebone it added Tuesday shifts as well as the empty days.
  - Fix: either rename the button "Build the rest of the week", or add a build for one day and use that.
  - Done: the button is now "Build the week from the forecast", which is what it does.
- [x] **Rate-limit screen.** Reloading quickly locks the app on "Cannot reach Preshift: Slow down: this key has made more than 300 requests this minute". That is developer wording and a dead end. A demo role trips it after about 15 reloads, because each load makes about 20 API calls.
  - Done when: the message is plain English and the app retries by itself after the wait the server gives.
  - Done: the app waits the time the server names (up to 30 seconds) and asks once more. A second refusal reads "Preshift is busy for a moment. Wait a few seconds, then try again."
- [x] **Unfilled gaps sit outside the decisions.** After a build, "7 gaps could not be filled legally" shows as a separate red card above the decisions bar.
  - Fix: make it a decision ("7 hours cannot be filled legally: hire or cross-train") and remove the separate card.
  - Done: on one site's rota they are a decision, ranked after the empty days, with Dismiss, and the days are tagged on the timeline. The separate card still shows on Sites, where the bar does not.
- [x] **The week's status contradicts itself.** Across all sites, the heading stamp says "1 blocking issue" while the strip's button says "Signed off and published". At one site, "Published" is said three times: in the stamp, the button and Keep doing.
  - Fix: one status, worked out once, said once.
  - Done: the heading is the one place it is said. A published week that picks up a blocking issue reads "Published, 1 blocking issue". The publish button shows only while there is something to publish, and Keep doing no longer repeats it.
- [x] **Links to a section you are not offered land elsewhere without saying why.** As a supervisor, 56 of 63 links landed silently on Rota. Others land on Sites.
  - Done when: a short note says the section is not part of the person's role.
  - Done: "Cases is not part of your role, so you are on Rota instead.", or "switched off for your organisation" for a feature an owner turned off. Only a link that named the section is explained, so a plain sign-in shows nothing. A browser check covers it.
- [x] **Supervisor clicking a shift.** The message reads "Your roles do not include this here."
  - Better: "You can see this rota. Only a manager can change shifts."
  - Done: it now reads "You can see this rota, but your roles do not let you change shifts here."
- [x] **GM with one site.** Opening Rota without a site shows Marylebone's figures under the heading "All sites".
  - Fix: name the site when the person has only one.
  - Done: someone with one site is always at it.
- [x] **Found while fixing: the top bar sat over open dialogs.** The bar from #127 was layered above the dark backdrop of every dialog, so its menus stayed clickable over an open editor.
  - Done: the bar now sits below dialog backdrops.

## 2. Clutter still on the screen

- [ ] **Two AI entry points.** The Tell Preshift bar and the Shifty button both sit fixed at the foot of every screen and cover content. On a phone they take about 130px.
  - Fix: merge them into one "Ask Shifty" button, with Ctrl K opening it.
- [ ] **Two banners on every screen.** "You are looking at the sample group" and "Coming up" are two cards on every section.
  - Fix: one notices line, with the sample-group message dismissible once read.
- [ ] **The P&L strip and its publish button appear too widely.** They show on Payroll, Tronc, Clocked vs rota, Forecast, Coach, Prime cost, Compliance risk, Reports, Close, Programme and Labour cost. Publishing the rota from Payroll is out of place.
  - Fix: show the full strip on Rota, Sites and Demand only, and a smaller version or none elsewhere.
- [ ] **Phone rota header.** The title, week picker, stamp, three buttons, the strip and the banners all come before the decisions. The rota starts about 1,000px down.
  - Fix: on a phone, put Ask the assistant, Clear week and Build in one menu, and put the stamp beside the week.
- [ ] **The decisions bar is tall.** With four decisions open it pushes the rota to the foot of a laptop screen. It also caused one CI failure on #127.
  - Fix: make each card shorter, with its button beside the text on wide screens.
- [ ] **Decisions shown to people who cannot act on them.** A supervisor is told "give them hours first".
  - Fix: show the bar only to people who can change the rota, or word it as information for everyone else.
- [ ] **Phone layout of tables and tabs.** The Staff requests "Rota seen" table squashes names into a narrow coded column. The Reports tabs wrap into a block. Tap targets are under 28px tall in several places: Rota (29), Features (55), Settings (21), Support (15).

## 3. Does the flow make sense

- [ ] **What's new is out of date.** This week's cards still send people to the "left-hand bar" (the Features, What's new and Go to cards), and the new layout has no card of its own.
  - Fix: write the card for the top bar, the decisions bar and the Simple / Standard / Expert switch, and correct the old wording.
- [ ] **Past weeks show a forecast P&L.** A week that has already traded shows "No forecast" and offers "Forecast from past takings".
  - Fix: show actual takings and actual labour for past weeks.
- [ ] **Sites opened at one site.** Sites is the group overview, but a link that carries a site shows a one-row table.
  - Fix: Sites always opens across every site, whatever the link says.
- [ ] **Review the decision rules with a GM.** Read the bar against two or three real weeks at real sites before it reaches every client. Agree what counts as a decision, the order and the wording.
- [ ] **Keep doing says little.** Today it only ever says the week is published.
  - Fix: add real positives once the rules above are agreed, for example a site on target for three weeks, or every request decided within a day.

## 4. Testing and tooling

- [ ] **The local dev sign-in has no person record.** Signed in as `dev@preshift.local`, Staff requests and Support fail with 403, and Support shows a red error. Real people never see this, but it hides real errors during local testing.
  - Fix: give the dev user a person record in the seed.
- [ ] **Viewing as a WS person cannot open Clients.** The list belongs to the signed-in account, not the role being viewed through.
  - Fix: either document it, or let viewing-as cover it.
- [ ] **Browser checks to add:**
  - no sideways scroll on any section at phone width;
  - the decisions bar on a past week and an empty week;
  - both editors closing on Escape.
  - Partly done: `e2e/screens.spec.ts` covers phone width, the past week, the shift editor and the refused link. Still to add: an empty week, and the person editor on Escape.
- [ ] **CI cold start.** The browser checks start before the API is ready. The employment rights check failed once on its first request, then passed on retry.
  - Fix: have Playwright's web server wait for the API's health endpoint, not only the web app.
