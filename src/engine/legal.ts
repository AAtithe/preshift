// The published legal pages, and the version a business accepts when it signs up.
//
// Each page's text lives in legal/*.md, the one place it is written and reviewed. Everything above
// the first line of three dashes is an internal note and is never published. `npm run legal` turns
// the rest into a static page under site/, and server/legal.test.ts fails if a page drifts from its
// source, so the words on the website are always the words that were approved.
//
// Sign-up records LEGAL_VERSION against the new organisation. Bump it for any material change to
// the Terms, the Data Processing Agreement or the Privacy Notice, and give account owners the 30
// days' notice clause 15 of the Terms promises.

export const LEGAL_VERSION = '2026-11-04';
/** The date the current version took effect, as printed on every page. */
export const LEGAL_EFFECTIVE = '4 November 2026';

export interface LegalPage {
  /** Published at /<slug>, from site/<slug>.html. */
  slug: string;
  /** Under legal/. */
  source: string;
  title: string;
  description: string;
}

export const LEGAL_PAGES: LegalPage[] = [
  { slug: 'terms', source: '01-terms-of-service.md', title: 'Terms of Service', description: 'The terms on which TeamPay Payroll Limited provides Preshift Rota to businesses.' },
  { slug: 'privacy', source: '02-privacy-notice.md', title: 'Privacy Notice', description: 'How Preshift Rota uses personal data, and what it holds for employers about their staff.' },
  { slug: 'dpa', source: '03-data-processing-agreement.md', title: 'Data Processing Agreement', description: 'The UK GDPR Article 28 terms on which Preshift Rota processes personal data for its customers.' },
  { slug: 'staff-terms', source: '05-staff-terms-of-use.md', title: 'Staff Terms of Use', description: 'What staff agree to when they use the Preshift staff app or kiosk.' },
  { slug: 'cookies', source: '06-cookie-notice.md', title: 'Cookies', description: 'The cookies and on-device storage Preshift Rota uses, and how to stop analytics counting your visits.' },
  { slug: 'subprocessors', source: '07-subprocessors.md', title: 'Sub-processors', description: 'The providers that process personal data for Preshift Rota, and where.' },
];

/**
 * What staff are shown in the staff app and on the kiosk: the terms they use it under, the summary
 * of what their employer keeps about them, and cookies. Staff are not party to the Terms of Service,
 * so it is not here. Each must be a published page (server/legal.test.ts checks).
 */
export const STAFF_LEGAL_LINKS: { href: string; label: string }[] = [
  { href: '/staff-terms', label: 'Staff terms' },
  { href: '/privacy#staff', label: 'Your data' },
  { href: '/cookies', label: 'Cookies' },
];

/** The device flag that stops Vercel Web Analytics counting a visit (read in src/main.tsx). */
export const ANALYTICS_OFF_KEY = 'preshift.analytics.off';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Bold, code and links, on text already escaped. Only site-relative links and anchors are allowed. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:\/|#)[^)\s]*)\)/g, '<a href="$2">$1</a>');
}

const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The published part of a source: everything after the first line of three dashes. */
export function publishedPart(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const rule = lines.findIndex((l) => l.trim() === '---');
  if (rule < 0) throw new Error('A legal source needs a line of three dashes between its internal notes and the published text.');
  return lines.slice(rule + 1).join('\n');
}

/**
 * The small part of Markdown the legal pages use: headings (with an optional {#id}), paragraphs,
 * bullet and numbered lists with indented continuation lines, tables, bold, code, site links, a
 * horizontal rule, and {{name}} blocks the page template fills.
 */
export function markdownToHtml(markdown: string, blocks: Record<string, string> = {}): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let i = 0;
  const isBlank = (l: string | undefined) => l === undefined || l.trim() === '';
  const startsBlock = (l: string) => /^(#{1,3} |- |\d+\. |\||---\s*$|\{\{)/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,3}) (.*?)(?:\s*\{#([a-z0-9-]+)\})?\s*$/);
    if (heading) {
      const level = heading[1].length;
      const id = heading[3] ?? slugify(heading[2]);
      out.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    const block = line.match(/^\{\{([a-z0-9-]+)\}\}\s*$/);
    if (block) {
      if (!(block[1] in blocks)) throw new Error(`No content for {{${block[1]}}}.`);
      out.push(blocks[block[1]]);
      i++;
      continue;
    }
    if (/^---\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i].replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim()));
        i++;
      }
      const [head, , ...body] = rows;
      out.push(
        '<div class="table"><table>',
        `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`,
        `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`,
        '</table></div>',
      );
      continue;
    }
    const item = line.match(/^(- |\d+\. )/);
    if (item) {
      const ordered = item[1] !== '- ';
      const items: string[] = [];
      while (i < lines.length) {
        const start = lines[i].match(ordered ? /^\d+\. (.*)$/ : /^- (.*)$/);
        if (!start) break;
        const parts = [start[1]];
        i++;
        // Continuation lines are indented; a blank line between numbered items does not end the list.
        while (i < lines.length && /^\s+\S/.test(lines[i])) parts.push(lines[i].trim()), i++;
        items.push(`<li>${inline(parts.join(' '))}</li>`);
        if (ordered && isBlank(lines[i]) && /^\d+\. /.test(lines[i + 1] ?? '')) i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i]))) para.push(lines[i].trim()), i++;
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

const OPT_OUT = `<div class="optout">
  <p id="optout-state" role="status">Checking this device&hellip;</p>
  <button type="button" id="optout">Stop counting my visits</button>
</div>
<script>
  (function () {
    var key = '${ANALYTICS_OFF_KEY}';
    var state = document.getElementById('optout-state');
    var button = document.getElementById('optout');
    function read() { try { return localStorage.getItem(key) === '1'; } catch (e) { return null; } }
    function show() {
      var off = read();
      if (off === null) { state.textContent = 'This browser blocks on-device storage, so the choice cannot be saved. Analytics cannot remember you either.'; button.hidden = true; return; }
      state.textContent = off ? 'Your visits on this device are not counted.' : 'Your visits on this device are counted.';
      button.textContent = off ? 'Count my visits again' : 'Stop counting my visits';
    }
    button.addEventListener('click', function () {
      try { read() ? localStorage.removeItem(key) : localStorage.setItem(key, '1'); } catch (e) {}
      show();
    });
    show();
  })();
</script>`;

/** The whole static page for one legal document. */
export function legalPageHtml(page: LegalPage, markdown: string): string {
  const body = markdownToHtml(publishedPart(markdown), { 'analytics-opt-out': OPT_OUT })
    // The first heading is the page title; the version line sits under it.
    .replace(/^(<h1 [^>]*>.*?<\/h1>)/, `$1\n<p class="version">Version ${LEGAL_VERSION}, effective ${LEGAL_EFFECTIVE}</p>`);
  const nav = LEGAL_PAGES.map((p) => (p.slug === page.slug ? `<a href="/${p.slug}" aria-current="page">${p.title}</a>` : `<a href="/${p.slug}">${p.title}</a>`)).join('\n        ');
  return `<!doctype html>
<!-- Generated from legal/${page.source} by npm run legal. Edit the source, not this file. -->
<html lang="en-GB">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(page.title)} | Preshift Rota</title>
    <meta name="description" content="${escapeHtml(page.description)}" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%230e0e10%22/%3E%3Ctext x=%2216%22 y=%2223%22 font-size=%2220%22 font-family=%22sans-serif%22 font-weight=%22800%22 fill=%22%23ff5e1a%22 text-anchor=%22middle%22%3Ep%3C/text%3E%3C/svg%3E" />
    <style>
      :root {
        --bg: #f6f1e6; --surface: #fffdf8; --border: #e2dccd; --text: #0e0e10; --muted: #5f5b52; --accent: #c2410c;
        color-scheme: light dark;
      }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #121211; --surface: #1b1b19; --border: #34332e; --text: #eceae4; --muted: #a8a49a; --accent: #ff8a4c; }
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
      header, main, footer { width: min(860px, 100%); margin: 0 auto; padding: 0 16px; }
      header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; padding-top: 20px; }
      .brand { font-weight: 800; font-size: 20px; color: var(--text); text-decoration: none; letter-spacing: -0.02em; }
      .brand span { color: var(--accent); }
      nav { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 14px; }
      nav a { color: var(--muted); }
      nav a[aria-current] { color: var(--text); font-weight: 600; text-decoration: none; }
      main { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 8px 24px 24px; margin-top: 16px; }
      h1 { font-size: 30px; line-height: 1.2; margin: 24px 0 4px; letter-spacing: -0.01em; }
      h2 { font-size: 20px; margin: 32px 0 8px; }
      h3 { font-size: 17px; margin: 24px 0 6px; }
      .version { color: var(--muted); font-size: 14px; margin: 0 0 24px; }
      a { color: var(--accent); }
      code { font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); padding: 1px 4px; border-radius: 4px; }
      ul, ol { padding-left: 22px; }
      li { margin: 4px 0; }
      hr { border: 0; border-top: 1px solid var(--border); margin: 28px 0; }
      .table { overflow-x: auto; margin: 12px 0; }
      table { border-collapse: collapse; width: 100%; font-size: 14px; }
      th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--border); }
      th { font-weight: 600; background: var(--bg); }
      .optout { border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
      .optout p { margin: 0 0 8px; }
      .optout button { font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
      footer { color: var(--muted); font-size: 13px; padding-top: 16px; padding-bottom: 32px; }
      @media (max-width: 600px) { main { padding: 4px 16px 16px; } h1 { font-size: 25px; } }
    </style>
  </head>
  <body>
    <header>
      <a class="brand" href="/">pre<span>shift.</span></a>
      <nav aria-label="Legal">
        ${nav}
      </nav>
    </header>
    <main>
${body}
    </main>
    <footer>
      Preshift Rota is a trading name of TeamPay Payroll Limited, registered in England and Wales, company number 17197586.
      Registered office: c/o Williams Stanley and Co, 144 Great Portland Street, London W1W 6QT. A Preshift and Williams, Stanley &amp; Co. venture.
    </footer>
  </body>
</html>
`;
}
