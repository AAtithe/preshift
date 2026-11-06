# Cookies and Similar Technologies

Source for the published page at /cookies (`site/cookies.html`). Edit here, then run
`npm run legal`. Everything above the first line of three dashes is internal.

Position: no advertising or tracking cookies. Every cookie and stored item is needed to sign in or
to remember a choice the user made, which PECR regulation 6(4) exempts from consent. Analytics is
cookieless and relies on the statistical purposes exemption added by the Data (Use and Access) Act
2025, which needs clear information and a simple way to object: the button below, which
`src/main.tsx` honours. So no consent banner. Confirm with the solicitor (to-do list A4).

---

# Cookies and Similar Technologies

Preshift Rota uses no advertising or tracking cookies. Everything below is needed to sign you in,
or remembers a choice you made.

## Cookies

| Name | Where | Purpose | Lasts |
| --- | --- | --- | --- |
| `ps_session` | Manager web app and demo | Keeps you signed in | 12 hours (demo: until midnight) |
| `ps_staff` | Staff app | Keeps you signed in on your phone | 30 days |
| `ps_kiosk` | Clock-in kiosk | Links a shared tablet to its site | 365 days |

All are first party, HttpOnly (scripts cannot read them) and SameSite=Lax. The marketing website
sets no cookies.

## Stored on your device

The manager app remembers display choices you make, such as your preferred rota view, screen
density, which hints and panels you have folded away, and whether you have seen this week's What's
new. These never leave your device. Item names begin `preshift.`.

The staff app uses a service worker so it can receive notifications you have allowed, and so it
opens quickly.

## Analytics

The manager web app uses Vercel Web Analytics to count which screens are used. It sets no cookies,
records the screen name only (never the site, week, any name or any token), and does not run in the
staff app, the kiosk or the marketing website.

You can stop your visits being counted on this device and browser with the button below. It is
remembered on this device until you clear your browser's data for this site.

{{analytics-opt-out}}

## Fonts

The website and manager app load fonts from Google Fonts, which receives your IP address so it can
send the font files.

## Contact

hello@preshift.co.uk
