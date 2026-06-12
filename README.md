# Anthropic Token Spend Report — Aptera

A static weekly report site tracking Anthropic API token top-up spend for Aptera Motors.

## Architecture

Each week, a scheduled Claude task runs `scripts/build-report.mjs`, which reads Ramp card transaction data and writes a JSON report file into `src/data/reports/YYYY-MM-DD.json`. Pushing that file to `main` triggers the GitHub Actions workflow, which rebuilds the Astro site and deploys it to GitHub Pages.

## Adding or re-running a report

```bash
node scripts/build-report.mjs scripts/topups-YYYY-MM-DD.json YYYY-MM-DD
```

This writes `src/data/reports/YYYY-MM-DD.json`. Commit and push to trigger a redeploy.

## Local development

```bash
npm install
npm run dev       # dev server at http://localhost:4321
npm run build     # production build → dist/
npm run preview   # preview the dist/ build
```

## Budget threshold

Edit `src/data/config.json` to set a monthly budget line on the charts:

```json
{ "monthlyBudgetThreshold": 25000 }
```

Set to `null` to hide the budget line.

## Schema reference

See `src/content.config.ts` for the full Zod schema that validates each weekly report JSON.
