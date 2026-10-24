import { RELEASES } from './walkthrough';
import { addRelease, checkDraft, draftFromReply, draftPrompt, nextMonday, plainDraft, releaseSource, rollCard, type DraftReply } from './whatsNewDraft';

const reply: DraftReply = {
  steps: [
    { for: 'GMs', title: 'Cover map', body: 'Where to add the next hour.', tryIt: 'Click a short hour.', tab: 'rota', lens: 'cover' },
    { for: 'Staff', title: "Pay in the staff app", body: "Shows each person's pay before tax.", tryIt: '', tab: '', lens: 'cover' },
  ],
  rows: [{ for: 'GMs', what: 'Cover map | on the Rota tab', why: 'Cuts the right hour.' }],
  test: 'Build next week and fill one short hour.',
};

const README = `# Preshift

Intro.

## What's new: week of 19 October 2026

A one-page card for the team. Read it in two minutes, then open the app and try each item once.
Past cards live in \`docs/WHATS_NEW.md\`.

| For | What changed | Why it matters |
| --- | --- | --- |
| GMs | Old row | Old reason |

The test for this week: the old test.

## Feature list

Rest.
`;

const HISTORY = `# What's new

How to write a card:

- One row per change.

## Week of 19 October 2026

A short summary.

## Week of 12 October 2026

Older.
`;

describe("drafting next week's What's new", () => {
  it('drafts for the coming Monday, whatever day it runs', () => {
    expect(nextMonday('2026-10-22')).toBe('2026-10-26');
    expect(nextMonday('2026-10-25')).toBe('2026-10-26');
    expect(nextMonday('2026-10-26')).toBe('2026-11-02');
  });

  it("turns Claude's reply into a release, keeping a rota view only where the step opens the rota", () => {
    const { release, rows } = draftFromReply('2026-11-02', reply);
    expect(release.steps[0]).toEqual({ for: 'GMs', title: 'Cover map', body: 'Where to add the next hour.', tryIt: 'Click a short hour.', tab: 'rota', lens: 'cover' });
    expect(release.steps[1]).toEqual({ for: 'Staff', title: 'Pay in the staff app', body: "Shows each person's pay before tax." });
    expect(rows).toHaveLength(1);
  });

  it('drops a section that does not exist rather than losing the step', () => {
    const { release } = draftFromReply('2026-11-02', { ...reply, steps: [{ ...reply.steps[0], tab: 'nowhere', lens: '' }] });
    expect(release.steps[0]).toEqual({ for: 'GMs', title: 'Cover map', body: 'Where to add the next hour.', tryIt: 'Click a short hour.' });
  });

  it('refuses a draft that would not ship', () => {
    expect(() => draftFromReply('2026-11-03', reply)).toThrow(/not a Monday/);
    expect(() => draftFromReply('2026-11-02', { ...reply, steps: [reply.steps[0], reply.steps[0]] })).toThrow(/two steps are called/);
    const dashed = { ...reply, test: 'Build the week — then publish.' };
    expect(() => draftFromReply('2026-11-02', dashed)).toThrow(/em dash/);
    expect(checkDraft({ release: { week: '2026-11-02', test: 't', steps: [{ for: 'GMs', title: 'x', body: 'y', tab: 'nowhere' as never }] }, rows: [{ for: 'GMs', what: 'a', why: 'b' }] })).toContain('"x" opens nowhere, which is not a section');
  });

  it('drafts plainly from the pull requests when Claude is not available', () => {
    const d = plainDraft('2026-11-02', [{ number: 7, title: 'Tronc in labour cash', body: '## Summary\n\nTips now leave on the payout day.\n\nMore.' }]);
    expect(d.release.steps).toEqual([{ for: 'Everyone', title: 'Tronc in labour cash', body: 'Tips now leave on the payout day.' }]);
    expect(checkDraft(d)).toEqual([]);
  });

  it('tells Claude every section it may open, and which changes merged', () => {
    const prompt = draftPrompt('2026-11-02', [{ number: 7, title: 'Tronc', body: 'Tips.' }], 'Rules.');
    expect(prompt).toContain('week of 2 November 2026');
    expect(prompt).toContain('cash: Labour cash');
    expect(prompt).toContain('### #7 Tronc');
  });

  it('writes the release into walkthrough.ts as the newest, quoting safely, and only once', () => {
    const source = "const x = 1;\nexport const RELEASES: Release[] = [\n  {\n    week: '2026-10-19',\n  },\n];\n";
    const { release } = draftFromReply('2026-11-02', reply);
    const next = addRelease(source, release);
    expect(next.indexOf("week: '2026-11-02'")).toBeLessThan(next.indexOf("week: '2026-10-19'"));
    expect(next).toContain("body: 'Shows each person\\'s pay before tax.',");
    expect(() => addRelease(next, release)).toThrow(/already written/);
  });

  it('writes source that reads back as the same release', () => {
    for (const r of RELEASES) {
      const read = new Function(`return ${releaseSource(r).trim().replace(/,$/, '')}`)();
      expect(read).toEqual(r);
    }
  });

  it("puts this week's card in the README and moves last week's into the history unchanged", () => {
    const draft = draftFromReply('2026-10-26', reply);
    const { readme, history } = rollCard(README, HISTORY, draft);
    expect(readme).toContain("## What's new: week of 26 October 2026");
    expect(readme).toContain('| GMs | Cover map / on the Rota tab | Cuts the right hour. |');
    expect(readme).toContain('The test for this week: Build next week and fill one short hour.');
    expect(readme).not.toContain('Old row');
    expect(readme).toMatch(/hour\.\n\n## Feature list/);
    // Last week's summary gives way to its full card, and older weeks are kept below it.
    expect(history).toContain('## Week of 19 October 2026\n\n| For | What changed | Why it matters |');
    expect(history).toContain('| GMs | Old row | Old reason |');
    expect(history).toContain('The test for this week: the old test.');
    expect(history).not.toContain('A short summary.');
    expect(history).not.toContain('A one-page card for the team');
    expect(history.indexOf('19 October')).toBeLessThan(history.indexOf('12 October'));
  });
});
