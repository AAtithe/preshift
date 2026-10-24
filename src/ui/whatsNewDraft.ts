// Drafting next week's What's new from what merged: the release the app walks through, and the
// README card it goes out with. Pure text in, text out, so the weekly job (scripts/whats-new.ts)
// and the tests share it. A person still reads and merges what it writes.
import { addDays, weekStart } from '../engine/time';
import { NAV_ITEMS } from './nav';
import { releaseLabel, type Release, type RotaLens, type WalkStep } from './walkthrough';

export const LENSES: RotaLens[] = ['timeline', 'people', 'cover', 'rest', 'stations', 'cost', 'changes', 'fairness'];
export const AUDIENCES = ['GMs', 'Staff', 'Finance', 'Admin', 'Owners', 'Operators', 'WS', 'Everyone'] as const;

/** A change that went into main this week, as the job reads it from GitHub. */
export interface MergedChange {
  number: number;
  title: string;
  body: string;
}

/** A row on the README card. */
export interface CardRow {
  for: string;
  what: string;
  why: string;
}

export interface Draft {
  release: Release;
  rows: CardRow[];
}

/** The Monday after the day given: the week the job drafts for. */
export function nextMonday(today: string): string {
  return addDays(weekStart(today), 7);
}

/**
 * What Claude is asked to return. Every field is required and closed, so the reply either fits the
 * release as written or is refused before anything is changed. No section and no lens are "".
 */
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['steps', 'rows', 'test'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['for', 'title', 'body', 'tryIt', 'tab', 'lens'],
        properties: {
          for: { type: 'string', enum: [...AUDIENCES] },
          title: { type: 'string' },
          body: { type: 'string' },
          tryIt: { type: 'string' },
          tab: { type: 'string', enum: ['', ...NAV_ITEMS.map((t) => t.id)] },
          lens: { type: 'string', enum: ['', ...LENSES] },
        },
      },
    },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['for', 'what', 'why'],
        properties: { for: { type: 'string', enum: [...AUDIENCES] }, what: { type: 'string' }, why: { type: 'string' } },
      },
    },
    test: { type: 'string' },
  },
} as const;

/** The reply as Claude gives it, before it becomes a release. */
export interface DraftReply {
  steps: { for: string; title: string; body: string; tryIt: string; tab: string; lens: string }[];
  rows: CardRow[];
  test: string;
}

const SECTIONS = NAV_ITEMS.map((t) => `${t.id}: ${t.label}`).join('\n');

/** The instructions the weekly job sends with the week's changes. */
export function draftPrompt(week: string, changes: MergedChange[], house: string): string {
  return [
    `Write the What's new for the ${releaseLabel(week).replace('Week', 'week')} in Preshift, a rota and labour app for UK hospitality run by Williams, Stanley & Co.`,
    'The readers are general managers, finance teams, operators and staff at bars, restaurants and cafes. They are busy and act on numbers.',
    '',
    'House rules for the card, from docs/WHATS_NEW.md:',
    house.trim(),
    '',
    'Write:',
    '- rows: one per change a person would notice. "what" says what changed in plain terms and where it is. "why" says why it matters to the operator or the P&L.',
    '- steps: the walkthrough, at most 10, one per change worth showing on screen, in the order a GM would care. title is a few words. body is two or three sentences: what changed and why it matters. tryIt is one thing to do on that screen, or "". tab is the section the step opens (from the list below), or "" if it is not in the manager app (the staff app, for example). lens is the rota view to open when tab is "rota", otherwise "".',
    '- test: one test the team can run in the app that week, two or three sentences.',
    '',
    'Leave out anything a customer would not notice: tests, CI, refactors, dependency bumps, analytics, internal tooling. If nothing qualifies, return empty steps and rows.',
    'British English. Plain words. No em dashes, no exclamation marks, no emojis, no hype. Name screens as the app does.',
    '',
    'Sections (id: label):',
    SECTIONS,
    '',
    'Rota views: ' + LENSES.join(', '),
    '',
    'Changes merged this week:',
    ...changes.map((c) => `\n### #${c.number} ${c.title}\n${c.body.trim().slice(0, 6000)}`),
  ].join('\n');
}

/** Turns Claude's reply into the week's draft, refusing one that would not ship. */
export function draftFromReply(week: string, reply: DraftReply): Draft {
  // The schema lists the sections, but a list that long reaches Claude as guidance rather than a
  // rule, so a section that does not exist is dropped: the step still shows, it just opens nothing.
  const tabs = new Set<string>(NAV_ITEMS.map((t) => t.id));
  const steps: WalkStep[] = reply.steps.map((s) => ({
    for: s.for,
    title: s.title.trim(),
    body: s.body.trim(),
    ...(s.tryIt.trim() ? { tryIt: s.tryIt.trim() } : {}),
    ...(tabs.has(s.tab) ? { tab: s.tab as WalkStep['tab'] } : {}),
    ...(s.tab === 'rota' && s.lens ? { lens: s.lens as RotaLens } : {}),
  }));
  const draft = { release: { week, test: reply.test.trim(), steps }, rows: reply.rows };
  const problems = checkDraft(draft);
  if (problems.length) throw new Error(`The draft cannot ship as written:\n- ${problems.join('\n- ')}`);
  return draft;
}

/** Without Claude: one row and one step per change, named by its title, for a person to rewrite. */
export function plainDraft(week: string, changes: MergedChange[]): Draft {
  const summary = (c: MergedChange) =>
    c.body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('-')) ?? c.title;
  return {
    release: {
      week,
      test: 'Try each change below once in the app this week. If any of them needs an explanation, that is the next thing to fix.',
      steps: changes.slice(0, 10).map((c) => ({ for: 'Everyone', title: c.title, body: summary(c) })),
    },
    rows: changes.map((c) => ({ for: 'Everyone', what: c.title, why: summary(c) })),
  };
}

/** What would stop a draft going out: the same rules the walkthrough tests hold every release to. */
export function checkDraft({ release, rows }: Draft): string[] {
  const problems: string[] = [];
  const tabs = new Set<string>(NAV_ITEMS.map((t) => t.id));
  if (weekStart(release.week) !== release.week) problems.push(`${release.week} is not a Monday`);
  if (release.steps.length === 0) problems.push('there are no steps');
  if (release.steps.length > 10) problems.push(`${release.steps.length} steps is more than two minutes`);
  if (!release.test) problems.push('there is no test for the week');
  if (rows.length === 0) problems.push('there are no rows for the card');
  const titles = release.steps.map((s) => s.title);
  for (const t of titles.filter((t, i) => titles.indexOf(t) !== i)) problems.push(`two steps are called "${t}"`);
  for (const s of release.steps) {
    if (!s.title || !s.body) problems.push('a step has no title or no body');
    if (s.tab && !tabs.has(s.tab)) problems.push(`"${s.title}" opens ${s.tab}, which is not a section`);
    if (s.lens && s.tab !== 'rota') problems.push(`"${s.title}" names a rota view but does not open the rota`);
  }
  const text = JSON.stringify({ release, rows });
  if (/—/.test(text)) problems.push('it uses an em dash');
  return problems;
}

/** The release as it is written in src/ui/walkthrough.ts. */
export function releaseSource(r: Release): string {
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const step = (s: WalkStep) =>
    [
      '      {',
      `        for: ${q(s.for)},`,
      `        title: ${q(s.title)},`,
      `        body: ${q(s.body)},`,
      ...(s.tryIt ? [`        tryIt: ${q(s.tryIt)},`] : []),
      ...(s.tab ? [`        tab: ${q(s.tab)},`] : []),
      ...(s.lens ? [`        lens: ${q(s.lens)},`] : []),
      '      },',
    ].join('\n');
  return ['  {', `    week: ${q(r.week)},`, `    test: ${q(r.test)},`, '    steps: [', ...r.steps.map(step), '    ],', '  },', ''].join('\n');
}

const RELEASES_OPEN = 'export const RELEASES: Release[] = [\n';

/** walkthrough.ts with the release added as the newest. A week already written is left alone. */
export function addRelease(source: string, r: Release): string {
  if (source.includes(`week: '${r.week}'`)) throw new Error(`A release for ${r.week} is already written`);
  if (!source.includes(RELEASES_OPEN)) throw new Error('Cannot find the list of releases in walkthrough.ts');
  return source.replace(RELEASES_OPEN, RELEASES_OPEN + releaseSource(r));
}

const CARD = /^## What's new: week of (.+)\n([\s\S]*?)(?=^## )/m;
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim();

/** Wraps a paragraph at about a hundred characters, as the README is written. */
function wrap(text: string, width = 100): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line].join('\n');
}

/**
 * The README with this week's card in place of last week's, and docs/WHATS_NEW.md with last week's
 * card moved in unchanged, newest first. A summary already there for that week gives way to the card.
 */
export function rollCard(readme: string, history: string, draft: Draft): { readme: string; history: string } {
  const m = CARD.exec(readme);
  if (!m) throw new Error("Cannot find the What's new card in the README");
  const [whole, oldWeek, oldBody] = m;
  const intro = 'A one-page card for the team. Read it in two minutes, then open the app and try each item once.\nPast cards live in `docs/WHATS_NEW.md`.';
  const card = [
    `## What's new: ${releaseLabel(draft.release.week).replace('Week', 'week')}`,
    '',
    intro,
    '',
    '| For | What changed | Why it matters |',
    '| --- | --- | --- |',
    ...draft.rows.map((r) => `| ${cell(r.for)} | ${cell(r.what)} | ${cell(r.why)} |`),
    '',
    wrap(`The test for this week: ${draft.release.test}`),
    '',
    '',
  ].join('\n');
  // The card's own introduction stays in the README; the history keeps the rows and the test.
  const moved = `## Week of ${oldWeek}\n\n${oldBody.replace(intro, '').trim()}\n\n`;
  const existing = new RegExp(`^## Week of ${oldWeek.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm');
  const firstWeek = /^## Week of /m;
  const nextHistory = existing.test(history)
    ? history.replace(existing, moved)
    : firstWeek.test(history)
      ? history.replace(firstWeek, `${moved}## Week of `)
      : `${history.trimEnd()}\n\n${moved}`;
  return { readme: readme.replace(whole, card), history: nextHistory.trimEnd() + '\n' };
}
