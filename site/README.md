# Preshift Rota marketing site

Static, dependency-free single page in the preshift.co.uk visual language (cream and ink,
coral accents, Bricolage Grotesque with Instrument Serif italics, JetBrains Mono labels).

```
site/index.html   Page
site/styles.css   Styles
site/main.js      Mobile nav, screen tabs, scroll reveal, true cost calculator
site/img          Product screens (webp, from docs/screens)
```

Preview locally:

```bash
npx serve site        # or: python3 -m http.server -d site 4173
```

Deploy by pointing any static host (Netlify, Vercel, Cloudflare Pages, S3) at the `site` folder.
No build step.

The true cost calculator in `main.js` mirrors `employeeWeekCost` in `src/engine/cost.ts`.
When the statutory rates in `src/engine/ukRates.ts` change each April, update the `RATES`
block in `main.js` and the figures in the page copy to match.
