import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGAL_PAGES, LEGAL_VERSION, legalPageHtml, markdownToHtml, publishedPart, STAFF_LEGAL_LINKS } from '../src/engine/legal';

// The legal pages on the website are generated from legal/*.md. What a business agrees to at
// sign-up must be exactly the text that was approved: this fails when a page is stale, when a
// placeholder or internal note would be published, or when the sign-up form and the site disagree
// on the version being accepted.

const root = path.resolve(__dirname, '..');
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), 'utf8');

describe('published legal pages', () => {
  for (const page of LEGAL_PAGES) {
    it(`site/${page.slug}.html is generated from legal/${page.source} (run npm run legal)`, () => {
      expect(read('site', `${page.slug}.html`)).toBe(legalPageHtml(page, read('legal', page.source)));
    });

    it(`legal/${page.source} publishes no placeholder or internal note`, () => {
      const published = publishedPart(read('legal', page.source));
      // A square bracket is only allowed as the text of a site link: [Terms](/terms) or [here](#staff).
      const withoutLinks = published.replace(/\[[^\]]+\]\((?:\/|#)[^)]*\)/g, '');
      expect(withoutLinks).not.toMatch(/\[|\]/);
      expect(published).not.toMatch(/legal\/0|to-do list|solicitor/i);
      expect(published).not.toMatch(/DRAFT/);
    });
  }

  it('names the contracting company on every page', () => {
    for (const page of LEGAL_PAGES) expect(read('site', `${page.slug}.html`)).toContain('TeamPay Payroll Limited, registered in England and Wales, company number 17197586');
  });

  it('is linked from the footer, the sign-in page and the demo, and served by the deployment', () => {
    const index = read('site', 'index.html');
    for (const slug of ['privacy', 'cookies', 'dpa', 'subprocessors', 'terms']) expect(index).toContain(`href="/${slug}"`);
    expect(index).not.toMatch(/<nav class="mono" aria-label="Legal">[\s\S]*?href="#"/);
    const login = read('site', 'login.html');
    for (const slug of ['terms', 'privacy', 'dpa', 'cookies']) expect(login).toContain(`href="/${slug}"`);
    expect(read('site', 'demo.html')).toContain('href="/terms"');
    const build = read('scripts', 'build-vercel.mjs');
    expect(build).toContain(`const legalPages = [${LEGAL_PAGES.map((p) => `'${p.slug}'`).join(', ')}];`);
  });

  it('shows staff the staff terms, their data and cookies, each a published page', () => {
    expect(STAFF_LEGAL_LINKS.map((l) => l.href)).toEqual(['/staff-terms', '/privacy#staff', '/cookies']);
    for (const { href } of STAFF_LEGAL_LINKS) {
      const [slug, anchor] = href.slice(1).split('#');
      expect(LEGAL_PAGES.map((p) => p.slug), href).toContain(slug);
      if (anchor) expect(read('site', `${slug}.html`), href).toContain(`id="${anchor}"`);
    }
    // The staff app links them on every screen; the kiosk's set-up screen links them.
    expect(read('src', 'staff', 'StaffApp.tsx')).toMatch(/STAFF_LEGAL_LINKS\.map[\s\S]*?<a [^>]*target="_blank"/);
    const kiosk = read('src', 'kiosk', 'KioskApp.tsx');
    expect(kiosk).toContain('<nav className="kiosk-legal"');
    // A paired kiosk shows the addresses as text, never a link that would take the shared iPad off the clock-in screen.
    const footer = kiosk.match(/<footer className="kiosk-foot[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(footer).toContain('STAFF_LEGAL_LINKS');
    expect(footer).not.toMatch(/<a\b|href=/);
  });

  it('asks sign-up to accept the current version', () => {
    const login = read('site', 'login.html');
    const boxes = [...login.matchAll(/<input type="checkbox" name="terms" value="([^"]+)"/g)].map((m) => m[1]);
    expect(boxes).toEqual([LEGAL_VERSION, LEGAL_VERSION]);
    expect(login).toMatch(/<input type="checkbox" name="terms" value="[^"]+" required \/>/);
  });
});

describe('legal markdown', () => {
  it('drops everything above the first rule', () => {
    expect(publishedPart('internal\n\n---\n\n# Public')).toBe('\n# Public');
    expect(() => publishedPart('# No rule')).toThrow();
  });

  it('renders headings, lists, tables, bold, code and site links, and escapes the rest', () => {
    const html = markdownToHtml(
      [
        '## 9. Staff {#staff}',
        'A & B <script> **bold** `code` [Terms](/terms) [out](https://example.com)',
        'continues here.',
        '',
        '- one',
        '  more',
        '- two',
        '',
        '1. first',
        '',
        '2. second',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
      ].join('\n'),
    );
    expect(html).toContain('<h2 id="staff">9. Staff</h2>');
    expect(html).toContain('<p>A &amp; B &lt;script&gt; <strong>bold</strong> <code>code</code> <a href="/terms">Terms</a> [out](https://example.com) continues here.</p>');
    expect(html).toContain('<ul><li>one more</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<thead><tr><th>A</th><th>B</th></tr></thead>');
    expect(html).toContain('<tbody><tr><td>1</td><td>2</td></tr></tbody>');
  });

  it('fills named blocks and refuses an unknown one', () => {
    expect(markdownToHtml('{{x}}', { x: '<div>x</div>' })).toBe('<div>x</div>');
    expect(() => markdownToHtml('{{y}}', {})).toThrow();
  });
});
