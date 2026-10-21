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
| Close | Rota to labour accrual journal by role nominal and site tracking category, exported in Xero manual journal format, plus an hours file for payroll. | `src/engine/journal.ts`, `src/ui/CloseView.tsx` |

## Running it

```bash
npm install
npm run dev      # http://localhost:5173/demo/ for the demo, http://localhost:5173/ for the live app
npm test         # engine and auth tests
npm run build    # typecheck and production build
```

## Demo and live app

One build serves two routes:

| Route | Who | Data |
| --- | --- | --- |
| `/demo/` | Anyone, no login | Two sample London sites (Marylebone and Shoreditch), held in the visitor's browser only. Never touches the database. |
| `/app/` | Signed-in users only | The account's own rota, stored in Neon and loaded and saved through the API. |

The live app is gated where it matters: every read and write goes through `api/`, which checks
the session cookie. The login screen in the browser is a convenience, not the security boundary.

### Neon set-up

1. Put the connection string in `DATABASE_URL`, in `.env.local` locally and in the Vercel
   project's environment variables for production.
2. `npm run db:migrate` creates the tables. They live in their own `preshift` schema because the
   firm database already has unrelated `public.users` and `public.sessions` tables.
3. Create users by hand (there is no public sign-up while founding sites are onboarded):

   ```bash
   npm run user:create -- --email jane@site.co.uk --name "Jane Smith" --account "Marylebone Group"
   ```

   The password is prompted for, minimum 12 characters. Users on the same account share one rota.

### How the login works

- Passwords are hashed with scrypt (`api/_lib/password.ts`); unknown emails still run a hash so
  timing does not reveal which emails exist.
- A successful login sets an HttpOnly, SameSite=Lax, Secure cookie holding a random token. Only
  the SHA-256 of that token is stored, so a database leak does not hand over live sessions.
  Sessions last 30 days; signing out deletes the row.
- Five failed attempts on an email in 15 minutes locks it for the rest of the window. Wrong
  current passwords on the change password screen count towards the same limit.
- Passwords set with `user:create` are flagged, and the user must choose their own on first
  sign-in. The API refuses rota data until they do.
- "Password" in the top bar changes it at any time. New passwords need 12 or more characters and
  cannot contain the email name or words tied to the app or the firm. Changing a password signs
  out every other device.
- State-changing endpoints only accept JSON, which blocks cross-site form posts.
- Saves carry a version number. If a colleague saved in between, the save is refused with a
  "reload" prompt rather than silently overwriting their work.

### Account set-up

A new account signs in to a five-step set-up (`src/ui/Setup.tsx`, rules in `src/engine/setup.ts`)
instead of sample data:

1. Sites: opening hours, loaded labour target and the Xero tracking category.
2. Roles: starts from the standard hospitality roles, each mapped to a wages nominal code.
3. Team: added one by one or pasted from a spreadsheet or payroll export (Name, Roles, Rate or
   salary, Date of birth, Contracted hours). Date of birth is required for minimum wage and young
   worker checks.
4. Trading and staffing: a typical week's net sales per day and average spend, plus covers or
   sales per person per hour for each role. Takings start blank on purpose.
5. Review: weekly labour budget per site, errors that block saving, and warnings such as pay
   below the minimum wage band.

The typical week is stored on the site and generates the forecast for any week opened, so the
rota never runs out of forecast. "Set-up" in the top bar reopens it later. Changes apply from this
week; past forecasts stay as the record, and rostered shifts that no longer fit (a leaver, a role
removed) are listed before they are deleted.

## Structure

```
src/engine   Pure TypeScript domain logic. No UI, fully unit tested. This is the product.
src/ui       React front end over the engine.
api          Vercel functions: login, logout, session check, rota load and save.
db           Neon schema.
scripts      Database admin: migrate and create users.
docs         Strategy and roadmap.
```

The engine is deliberately framework-free so it can move server-side unchanged when we add
persistence, multi-user access and integrations.

## Statutory rates

All UK parameters live in `src/engine/ukRates.ts` and are set for 2026/27. They change every
April and must be checked against GOV.UK before each tax year.

See `docs/STRATEGY.md` for the competitive position, JV model and roadmap.
