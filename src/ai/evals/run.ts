import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ROTA_MODEL, RotaAgentError, runRotaAgent, type RotaAgentResult } from '../rotaAgent';
import { CASES, grade, WEEK, type CheckResult, type EvalCase } from './cases';

/**
 * Runs the evaluation set against the real model through the production entry point
 * (runRotaAgent with the production tools, prompt and settings). Writes, per run:
 *   results.jsonl    one graded row per (case, rep) that produced an answer
 *   errors.jsonl     attempts that never produced a gradeable answer: API errors, timeouts, wrong model
 *   transcripts/     every message, tool step and note, per (case, rep)
 *   summary.md       pass rates with 95% intervals, per case and per check, and the cost
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
  rep: number;
  /** answered: graded normally. refusal / truncated / turn_limit: the model's own outcome, graded as a fail. */
  status: 'answered' | 'refusal' | 'truncated' | 'turn_limit';
  pass: boolean;
  checks: CheckResult[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  servedModels: string[];
  steps: number;
  seconds: number;
}

interface ErrorRow {
  case: string;
  rep: number;
  failure: 'api_error' | 'timeout' | 'served_model_mismatch' | 'harness_error';
  message: string;
  seconds: number;
}

/** Wilson score interval: honest error bars on a pass rate from few trials. */
export function wilson(passes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = passes / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

async function runOne(client: Anthropic, c: EvalCase, rep: number, timeoutMinutes: number): Promise<{ row?: ResultRow; error?: ErrorRow; transcript: unknown }> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  const { state, insights } = c.setup();
  const before = structuredClone(state);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMinutes * 60_000);
  let result: RotaAgentResult | undefined;
  try {
    for (const instruction of c.instructions) {
      result = await runRotaAgent(
        client,
        { state, siteIds: c.siteIds, weekStart: WEEK, instruction, now: c.now, insights, previous: result },
        () => {},
        abort.signal,
      );
    }
    const r = result!;
    if (r.servedModels.some((m) => m !== ROTA_MODEL)) {
      return {
        error: { case: c.id, rep, failure: 'served_model_mismatch', message: `served by ${r.servedModels.join(', ')}`, seconds: seconds() },
        transcript: r,
      };
    }
    const graded = grade(c, { before, after: r.state, summary: r.summary, siteIds: c.siteIds, now: c.now });
    return {
      row: {
        case: c.id, rep, status: 'answered', pass: graded.pass, checks: graded.checks,
        costUsd: r.usage.costUsd, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens,
        servedModels: r.servedModels, steps: r.steps.length, seconds: seconds(),
      },
      transcript: { case: c.id, rep, instructions: c.instructions, summary: r.summary, steps: r.steps, checks: graded.checks, messages: r.messages },
    };
  } catch (err) {
    if (err instanceof RotaAgentError && err.kind !== 'input') {
      // The model's own outcome: counted, shown, and graded as a fail, but kept distinct from wrong answers.
      const status = err.kind;
      return {
        row: {
          case: c.id, rep, status, pass: false, checks: [{ name: status, pass: false, detail: err.message }],
          costUsd: result?.usage.costUsd ?? 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          servedModels: result?.servedModels ?? [], steps: result?.steps.length ?? 0, seconds: seconds(),
        },
        transcript: { case: c.id, rep, error: err.message },
      };
    }
    const failure: ErrorRow['failure'] = abort.signal.aborted ? 'timeout' : err instanceof Anthropic.APIError ? 'api_error' : 'harness_error';
    return { error: { case: c.id, rep, failure, message: (err as Error).message, seconds: seconds() }, transcript: { case: c.id, rep, error: String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

export async function runEval(options: RunOptions) {
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

export function summarise(cases: EvalCase[], rows: ResultRow[], errors: ErrorRow[], reps: number): string {
  const passes = rows.filter((r) => r.pass).length;
  const [lo, hi] = wilson(passes, rows.length);
  const cost = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const lines = [
    `# Rota assistant evaluation`,
    ``,
    `Model ${ROTA_MODEL}. ${cases.length} cases, ${reps} rep${reps === 1 ? '' : 's'} each. ${rows.length} graded, ${errors.length} errors (not scored).`,
    ``,
    `Overall pass rate: ${pct(rows.length ? passes / rows.length : 0)} (95% interval ${pct(lo)} to ${pct(hi)}). Cost $${cost.toFixed(2)}, about $${(rows.length ? cost / rows.length : 0).toFixed(2)} a draft.`,
    `Refusals ${rows.filter((r) => r.status === 'refusal').length}, truncated ${rows.filter((r) => r.status === 'truncated').length}, turn limit ${rows.filter((r) => r.status === 'turn_limit').length}.`,
    ``,
    `| Case | Passed | Failing checks |`,
    `| --- | --- | --- |`,
  ];
  for (const c of cases) {
    const mine = rows.filter((r) => r.case === c.id);
    const failing = [...new Set(mine.flatMap((r) => r.checks.filter((x) => !x.pass).map((x) => x.name)))];
    lines.push(`| ${c.id} | ${mine.filter((r) => r.pass).length} of ${mine.length} | ${failing.join(', ') || '-'} |`);
  }
  const byCheck = new Map<string, { pass: number; n: number }>();
  for (const r of rows.filter((x) => x.status === 'answered')) {
    for (const check of r.checks) {
      const key = check.name.replace(/_(mar|fitz|shd)$/, '');
      const t = byCheck.get(key) ?? { pass: 0, n: 0 };
      t.n++;
      if (check.pass) t.pass++;
      byCheck.set(key, t);
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
