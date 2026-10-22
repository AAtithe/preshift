import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runEval, wilson } from './run';

type Reply = { model?: string; stop_reason: string; content: unknown[] };
const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** A scripted stand-in for Claude, so the whole pipeline is checked without spending anything. */
function fake(script: (call: number) => Reply | Error) {
  let call = 0;
  return {
    beta: {
      messages: {
        create: async () => {
          const next = script(call++);
          if (next instanceof Error) throw next;
          return { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', usage, ...next };
        },
      },
    },
  } as unknown as Anthropic;
}

const tmp = () => mkdtemp(path.join(tmpdir(), 'eval-'));
const quiet = () => {};

describe('evaluation runner', () => {
  it('scores a good answer as a pass and doing nothing as a fail, and writes every file', async () => {
    const outDir = await tmp();
    // Builds from the forecast, then writes a short note: the right answer for build-basic.
    const good = fake((i) =>
      i % 2 === 0
        ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${i}`, name: 'build_from_forecast', input: { site_ids: null, exclude_employee_ids: [], allow_cover: true } }] }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Built the week; labour is under target.' }] },
    );
    const passed = await runEval({ caseIds: ['build-basic'], reps: 2, concurrency: 1, timeoutMinutes: 1, outDir, client: good, log: quiet });
    expect(passed.rows.map((r) => r.pass)).toEqual([true, true]);
    expect(passed.summary).toContain('Overall pass rate: 100%');

    const lazy = fake(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }));
    const failed = await runEval({ caseIds: ['build-basic'], reps: 1, concurrency: 1, timeoutMinutes: 1, outDir, client: lazy, log: quiet });
    expect(failed.rows[0].pass).toBe(false);
    expect(failed.rows[0].checks.find((c) => c.name === 'cover_mar')?.pass).toBe(false);

    const transcript = JSON.parse(await readFile(path.join(outDir, 'transcripts', 'build-basic-0.json'), 'utf8'));
    expect(transcript.summary).toBe('Done.');
    expect((await readFile(path.join(outDir, 'results.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('keeps errors, wrong models and refusals out of the wrong-answer count', async () => {
    const outDir = await tmp();
    const wrongModel = fake(() => ({ model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }));
    const a = await runEval({ caseIds: ['check-only'], reps: 1, concurrency: 1, timeoutMinutes: 1, outDir, client: wrongModel, log: quiet });
    expect(a.rows).toHaveLength(0);
    expect(a.errors[0]).toMatchObject({ failure: 'served_model_mismatch' });

    const broken = fake(() => new Anthropic.InternalServerError(500, { error: { message: 'overloaded' } }, 'overloaded', new Headers()));
    const b = await runEval({ caseIds: ['check-only'], reps: 1, concurrency: 1, timeoutMinutes: 1, outDir, client: broken, log: quiet });
    expect(b.errors[0]).toMatchObject({ failure: 'api_error' });
    expect(await readFile(path.join(outDir, 'errors.jsonl'), 'utf8')).toContain('api_error');

    const refuses = fake(() => ({ stop_reason: 'refusal', content: [] }));
    const c = await runEval({ caseIds: ['check-only'], reps: 1, concurrency: 1, timeoutMinutes: 1, outDir, client: refuses, log: quiet });
    expect(c.rows[0]).toMatchObject({ status: 'refusal', pass: false });
    expect(c.summary).toContain('Refusals 1');
  });

  it('reports honest intervals', () => {
    const [lo, hi] = wilson(9, 10);
    expect(lo).toBeGreaterThan(0.55);
    expect(hi).toBeLessThan(1);
    expect(wilson(0, 0)).toEqual([0, 0]);
  });
});
