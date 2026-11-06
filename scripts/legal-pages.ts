// Writes the published legal pages (site/<slug>.html) from their sources in legal/.
// Run after editing any legal/*.md: npm run legal. server/legal.test.ts fails if a page is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LEGAL_PAGES, legalPageHtml } from '../src/engine/legal';

const root = path.resolve(import.meta.dirname, '..');
for (const page of LEGAL_PAGES) {
  const html = legalPageHtml(page, readFileSync(path.join(root, 'legal', page.source), 'utf8'));
  writeFileSync(path.join(root, 'site', `${page.slug}.html`), html);
  console.log(`site/${page.slug}.html`);
}
