# Preshift Rota: Cookies and Similar Technologies

DRAFT v0.1, 1 November 2026. Publish at [preshift.co.uk/cookies].

Position: Preshift uses no advertising or tracking cookies. Every cookie and stored item is
needed to sign in or to remember a choice the user made, which PECR regulation 6(4) exempts from
consent. Analytics is cookieless and covered by the statistical purposes exemption introduced by
the Data (Use and Access) Act 2025, which requires clear information and a simple way to object.
On that basis no consent banner is needed, provided the opt-out below is built (to-do list P6).
Confirm with the solicitor.

---

## Cookies

| Name | Where | Purpose | Lasts |
| --- | --- | --- | --- |
| `ps_session` | Manager web app and demo | Keeps you signed in | 12 hours (demo: until midnight) |
| `ps_staff` | Staff app | Keeps you signed in on your phone | 30 days |
| `ps_kiosk` | Clock-in kiosk | Links a shared tablet to its site | 365 days |

All are first party, HttpOnly (scripts cannot read them) and SameSite=Lax. The marketing website
sets no cookies.

## Stored on your device (local storage)

The manager app remembers display choices you make, such as your preferred rota view, screen
density, which hints and panels you have folded away, and whether you have seen this week's
What's new. These never leave your device. Item names begin `preshift.`.

The staff app uses a service worker so it can receive notifications you have allowed, and so it
opens quickly.

## Analytics

The manager web app uses Vercel Web Analytics to count which screens are used. It sets no cookies,
records the page path only (never the site, week, any name or any token), and does not run in the
staff app, the kiosk or the marketing website. To opt out: [Settings, then Privacy, then "Do not
count my visits" (to build)].

## Fonts

The website and manager app currently load fonts from Google Fonts, which receives your IP
address. [Delete this section once fonts are self-hosted.]

## Contact

[privacy@preshift.co.uk]
