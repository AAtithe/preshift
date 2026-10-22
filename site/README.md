# Preshift Rota marketing site

Static, dependency-free single page in the preshift.co.uk visual language (cream and ink,
coral accents, Bricolage Grotesque with Instrument Serif italics, JetBrains Mono labels).

```
site/index.html   Page
site/styles.css   Styles
site/main.js      Mobile nav, screen tabs, scroll reveal, true cost calculator
site/img          Product screens for the viewer on the home page (webp, 1600 x 1111)
```

Preview locally:

```bash
npx serve site        # or: python3 -m http.server -d site 4173
```

Vercel builds with `npm run build:vercel` (see `vercel.json` and the Deployment section of the
root README): the marketing site is served at `/`, the web app at `/app/` and the API at `/v1`. Any other static host can serve the `site` folder on its own.

The true cost calculator in `main.js` mirrors `employeeWeekCost` in `src/engine/cost.ts`.
When the statutory rates in `src/engine/ukRates.ts` change each April, update the `RATES`
block in `main.js` and the figures in the page copy to match.

The price calculator in `main.js` mirrors `PRICING` in `src/engine/pricing.ts`, which Stripe and the
Billing page charge from. Change prices there first; `server/pricing.test.ts` fails until the `PRICING`
block in `main.js` and the figures in the pricing section's copy match.

To refresh the product screens after the app changes: run `npm run dev`, sign in with the local
development login it prints, build a full future week from the forecast, and capture each view at
1440 x 1000 (2x) with the site set to Marylebone and any notices dismissed. Save them to `site/img`
under the same names as WebP at 1600 x 1111, and update the alt text and captions in `main.js`.

