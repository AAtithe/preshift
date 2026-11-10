import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { runAppAgent, type AppAgentReply } from '../appAgent';
import { ROTA_MODEL, RotaAgentError } from '../rotaAgent';
import { wilson } from './run';
import { CASES, grade, type CheckResult, type ShiftyCase, type TurnResult } from './shiftyCases';

/**
 * Runs Shifty's evaluation set against the real model through the production entry point
 * (runAppAgent with Shifty's own prompt, tools and settings). Nothing is saved anywhere: Shifty only
 * proposes, and the cards are graded where they land. Writes, per run:
 *   results.jsonl    one graded row per (case, rep) that produced an answer
 *   errors.jsonl     attempts that never produced a gradeable answer: API errors, timeouts, wrong model
 *   transcripts/     every message, card and reply, per (case, rep)
 *   summary.md       pass rates with 95% intervals, per group, case and check, and the cost
 */

export interface RunOptions {
  caseIds?: string[];
  reps: number;
  concurrency: number;
  outDir: string;
  /** Hard ceiling per (case, rep), however lively the connection looks. */
  timeoutMinutes: number;
  client?: Anthropic;
  log?: (line: string) => void;
}

interface ResultRow {
  case: string;
  group: string;
  rep: number;
  /** answered: graded normally. refusal / truncated / turn_limit: the model's own outcome, graded as a fail. */
  status: 'answered' | 'refusal' | 'truncated' | 'turn_limit';
  pass: boolean;
  checks: CheckResult[];
  costUsd: number;
  servedModels: string[];
  steps: number;
  seconds: number;
}

interface ErrorRow {
  case: string;
  rep: number;
  failure: 'api_error' | 'timeout' | 'served_model_mismatch' | 'harness_error';
  message: string;
  costUsd: number;
  seconds: number;
}

const WHERE = { screen: 'rota', scope: 'Marylebone', user: 'gm@marylebone.example (Marylebone GM)' };

async function runOne(client: Anthropic, c: ShiftyCase, rep: number, timeoutMinutes: number): Promise<{ row?: ResultRow; error?: ErrorRow; transcript: unknown }> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  const ctx = c.setup();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMinutes * 60_000);
  const turns: TurnResult[] = [];
  const replies: AppAgentReply[] = [];
  const spent = () => replies.reduce((sum, r) => sum + r.costUsd, 0);
  try {
    let messages: AppAgentReply['messages'] = [];
    for (const turn of c.turns) {
      const r = await runAppAgent(client, { messages, text: turn.text, ctx, where: WHERE, outcomes: turn.outcomes }, abort.signal);
      replies.push(r);
      turns.push({ proposals: r.proposals, reply: r.reply });
      messages = r.messages;
    }
    const served = [...new Set(replies.flatMap((r) => r.servedModels))];
    if (served.some((m) => m !== ROTA_MODEL)) {
      return {
        error: { case: c.id, rep, failure: 'served_model_mismatch', message: `served by ${served.join(', ')}`, costUsd: spent(), seconds: seconds() },
        transcript: { case: c.id, rep, turns, messages },
      };
    }
    // Graded against a fresh copy of the starting point, so nothing the run touched colours the figures.
    const graded = await grade(c, { ctx: c.setup(), turns });
    return {
      row: {
        case: c.id, group: c.tags[0], rep, status: 'answered', pass: graded.pass, checks: graded.checks,
        costUsd: spent(), servedModels: served, steps: replies.reduce((n, r) => n + r.steps.length, 0), seconds: seconds(),
      },
      transcript: { case: c.id, rep, said: c.turns, turns, steps: replies.map((r) => r.steps), checks: graded.checks, messages },
    };
  } catch (err) {
    if (err instanceof RotaAgentError && err.kind !== 'input') {
      // The model's own outcome: counted, shown, and graded as a fail, but kept distinct from wrong answers.
      const status = err.kind;
      return {
        row: {
          case: c.id, group: c.tags[0], rep, status, pass: false, checks: [{ name: status, pass: false, detail: err.message }],
          costUsd: spent(), servedModels: [...new Set(replies.flatMap((r) => r.servedModels))], steps: 0, seconds: seconds(),
        },
        transcript: { case: c.id, rep, turns, error: err.message },
      };
    }
    const failure: ErrorRow['failure'] = abort.signal.aborted ? 'timeout' : err instanceof Anthropic.APIError ? 'api_error' : 'harness_error';
    return { error: { case: c.id, rep, failure, message: (err as Error).message, costUsd: spent(), seconds: seconds() }, transcript: { case: c.id, rep, turns, error: String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

export async function runShiftyEval(options: RunOptions) {
  const log = options.log ?? console.log;
  const cases = options.caseIds?.length ? CASES.filter((c) => options.caseIds!.includes(c.id)) : CASES;
  if (!cases.length) throw new Error(`No cases match ${options.caseIds?.join(', ')}. Known: ${CASES.map((c) => c.id).join(', ')}`);
  // Retries with backoff for 429 and 5xx are the SDK's; a second failure lands in errors.jsonl.
  const client = options.client ?? new Anthropic({ maxRetries: 4 });
  await mkdir(path.join(options.outDir, 'transcripts'), { recursive: true });

  const jobs = cases.flatMap((c) => Array.from({ length: options.reps }, (_, rep) => ({ c, rep })));
  const rows: ResultRow[] = [];
  const errors: ErrorRow[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { c, rep } = jobs[next++];
      const out = await runOne(client, c, rep, options.timeoutMinutes);
      await writeFile(path.join(options.outDir, 'transcripts', `${c.id}-${rep}.json`), JSON.stringify(out.transcript, null, 2));
      if (out.row) rows.push(out.row);
      if (out.error) errors.push(out.error);
      log(out.row ? `${out.row.pass ? 'pass' : 'FAIL'}  ${c.id} #${rep}  $${out.row.costUsd.toFixed(3)}  ${out.row.seconds}s` : `ERROR ${c.id} #${rep}  ${out.error!.failure}: ${out.error!.message}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

  rows.sort((a, b) => a.case.localeCompare(b.case) || a.rep - b.rep);
  await writeFile(path.join(options.outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(path.join(options.outDir, 'errors.jsonl'), errors.map((r) => JSON.stringify(r)).join('\n') + (errors.length ? '\n' : ''));
  const summary = summarise(cases, rows, errors, options.reps);
  await writeFile(path.join(options.outDir, 'summary.md'), summary);
  return { rows, errors, summary };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const rate = (pass: number, n: number) => {
  const [lo, hi] = wilson(pass, n);
  return `${pct(n ? pass / n : 0)} (${pass} of ${n}; 95% interval ${pct(lo)} to ${pct(hi)})`;
};

export function summarise(cases: ShiftyCase[], rows: ResultRow[], errors: ErrorRow[], reps: number): string {
  const cost = rows.reduce((sum, r) => sum + r.costUsd, 0) + errors.reduce((sum, r) => sum + r.costUsd, 0);
  const lines = [
    `# Shifty evaluation`,
    ``,
    `Model ${ROTA_MODEL}. ${cases.length} cases, ${reps} rep${reps === 1 ? '' : 's'} each. ${rows.length} graded, ${errors.length} errors (not scored).`,
    ``,
    `Overall pass rate: ${rate(rows.filter((r) => r.pass).length, rows.length)}. Cost $${cost.toFixed(2)}, about $${(rows.length ? cost / rows.length : 0).toFixed(3)} a conversation.`,
    `Refusals ${rows.filter((r) => r.status === 'refusal').length}, truncated ${rows.filter((r) => r.status === 'truncated').length}, turn limit ${rows.filter((r) => r.status === 'turn_limit').length}.`,
    ``,
    `| Group | Pass rate |`,
    `| --- | --- |`,
  ];
  for (const group of [...new Set(cases.map((c) => c.tags[0]))]) {
    const mine = rows.filter((r) => r.group === group);
    lines.push(`| ${group} | ${rate(mine.filter((r) => r.pass).length, mine.length)} |`);
  }
  lines.push('', '| Case | Passed | Failing checks |', '| --- | --- | --- |');
  for (const c of cases) {
    const mine = rows.filter((r) => r.case === c.id);
    const failing = [...new Set(mine.flatMap((r) => r.checks.filter((x) => !x.pass).map((x) => x.name)))];
    lines.push(`| ${c.id} | ${mine.filter((r) => r.pass).length} of ${mine.length} | ${failing.join(', ') || '-'} |`);
  }
  const byCheck = new Map<string, { pass: number; n: number }>();
  for (const r of rows.filter((x) => x.status === 'answered')) {
    for (const check of r.checks) {
      const t = byCheck.get(check.name) ?? { pass: 0, n: 0 };
      t.n++;
      if (check.pass) t.pass++;
      byCheck.set(check.name, t);
    }
  }
  lines.push('', '| Check | Pass rate |', '| --- | --- |');
  for (const [name, t] of [...byCheck].sort((a, b) => a[1].pass / a[1].n - b[1].pass / b[1].n)) {
    lines.push(`| ${name} | ${pct(t.pass / t.n)} (${t.pass} of ${t.n}) |`);
  }
  if (errors.length) {
    lines.push('', 'Errors (not scored):', ...errors.map((e) => `- ${e.case} #${e.rep}: ${e.failure}, ${e.message}`));
  }
  return lines.join('\n') + '\n';
}
