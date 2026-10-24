// Drafts next week's What's new from the pull requests merged into main this week: the release the
// app walks everyone through, live and in the demo, and the README card it goes out with. Run each
// week by .github/workflows/whats-new.yml, which opens the draft as a pull request for a person to
// read, correct and merge. The app holds the release back until its Monday either way.
//
//   npm run whats-new                       drafts the coming Monday from the last seven days
//   npm run whats-new -- --week 2026-11-02 --since 2026-10-26
//   npm run whats-new -- --plain            without Claude: one row per change, to rewrite by hand
//   npm run whats-new -- --dry-run          prints the draft and changes nothing
//
// GitHub is read with GITHUB_TOKEN when set (the workflow sets it), GITHUB_REPOSITORY names the
// repository. Claude writes the copy when ANTHROPIC_API_KEY is set; without it the draft is plain.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { addDays, toISODate } from '../src/engine/time';
import { RELEASES } from '../src/ui/walkthrough';
import {
  addRelease,
  checkDraft,
  draftFromReply,
  draftPrompt,
  DRAFT_SCHEMA,
  nextMonday,
  plainDraft,
  rollCard,
  type Draft,
  type MergedChange,
} from '../src/ui/whatsNewDraft';

const MODEL = 'claude-opus-5-5';
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const today = toISODate(new Date());
const week = flag('week') ?? nextMonday(today);
const since = flag('since') ?? addDays(today, -7);
const dryRun = args.includes('--dry-run');
const repo = process.env.GITHUB_REPOSITORY ?? 'AAtithe/preshift';

/** Pull requests merged into main on or after the day given, oldest first. */
async function mergedSince(day: string): Promise<MergedChange[]> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const found: (MergedChange & { mergedAt: string })[] = [];
  // Closed pull requests, most recently updated first: once a page holds nothing updated since the
  // day, nothing later will have merged since it either.
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub refused the list of pull requests: ${res.status} ${await res.text()}`);
    const prs = (await res.json()) as { number: number; title: string; body: string | null; merged_at: string | null; updated_at: string }[];
    for (const pr of prs) if (pr.merged_at && pr.merged_at.slice(0, 10) >= day) found.push({ number: pr.number, title: pr.title, body: pr.body ?? '', mergedAt: pr.merged_at });
    if (prs.length < 100 || prs.every((pr) => pr.updated_at.slice(0, 10) < day)) break;
  }
  return found.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt)).map(({ mergedAt: _at, ...c }) => c);
}

/** The house rules for a card, from the top of docs/WHATS_NEW.md. */
function houseRules(history: string) {
  return history.split(/^## Week of /m)[0].replace(/^# What's new\s*/, '');
}

async function claudeDraft(changes: MergedChange[], history: string): Promise<Draft> {
  const client = new Anthropic({ maxRetries: 4 });
  // A request Claude declines is passed to the model best placed to answer it, rather than failing the week.
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: jsonSchemaOutputFormat(DRAFT_SCHEMA) },
    messages: [{ role: 'user', content: draftPrompt(week, changes, houseRules(history)) }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to draft the week');
  if (response.stop_reason === 'max_tokens') throw new Error('The draft ran past its length; nothing was written');
  if (!response.parsed_output) throw new Error('Claude did not return a draft in the expected shape');
  return draftFromReply(week, response.parsed_output);
}

/** Tells the workflow what happened, when it runs in one. */
function output(values: Record<string, string>) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(values)) appendFileSync(process.env.GITHUB_OUTPUT, `${k}<<EOF\n${v}\nEOF\n`);
}

if (RELEASES.some((r) => r.week === week)) {
  console.log(`The release for ${week} is already written. Nothing to do.`);
  output({ drafted: 'false' });
  process.exit(0);
}

const changes = await mergedSince(since);
if (changes.length === 0) {
  console.log(`Nothing merged into main since ${since}. Nothing to draft.`);
  output({ drafted: 'false' });
  process.exit(0);
}

const history = readFileSync('docs/WHATS_NEW.md', 'utf8');
const plain = args.includes('--plain') || !process.env.ANTHROPIC_API_KEY;
const draft = plain ? plainDraft(week, changes) : await claudeDraft(changes, history);
const problems = checkDraft(draft);
if (problems.length) throw new Error(`The draft cannot ship as written:\n- ${problems.join('\n- ')}`);

const source = addRelease(readFileSync('src/ui/walkthrough.ts', 'utf8'), draft.release);
const card = rollCard(readFileSync('README.md', 'utf8'), history, draft);

const summary = [
  `What's new for the week of ${week}, drafted from ${changes.length} pull request${changes.length === 1 ? '' : 's'} merged since ${since}:`,
  '',
  ...changes.map((c) => `- #${c.number} ${c.title}`),
  '',
  plain
    ? 'Written without Claude, one row per pull request. Rewrite each step and row before merging: say what changed for an operator, and why it matters to them or the P&L. Drop anything a customer would not notice.'
    : `Written by Claude (${MODEL}). Read every step on the screen it opens before merging, and cut anything that is not true or not worth a GM's two minutes.`,
  '',
  `The app shows it to everyone, live and in the demo, from Monday ${week}. Merge before then.`,
].join('\n');

if (dryRun) {
  console.log(JSON.stringify(draft, null, 2));
  console.log(`\n${summary}`);
  process.exit(0);
}
writeFileSync('src/ui/walkthrough.ts', source);
writeFileSync('README.md', card.readme);
writeFileSync('docs/WHATS_NEW.md', card.history);
console.log(summary);
output({ drafted: 'true', week, summary });
