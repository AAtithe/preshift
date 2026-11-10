import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runShiftyEval } from './shiftyRun';

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

const tmp = () => mkdtemp(path.join(tmpdir(), 'shifty-eval-'));
const quiet = () => {};
const text = (t: string): Reply => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

describe('Shifty evaluation runner', () => {
  it('scores a good answer as a pass and a false "done" as a fail, and writes every file', async () => {
    const outDir = await tmp();
    // Proposes the starter through the real tool, then a short reply: the right answer for add-starter.
    const input = {
      name: 'Sam Lee', site_id: 'mar', role_ids: ['bar'], start_date: '2026-10-26', date_of_birth: '1999-05-01',
      pay_basis: 'hourly', hourly_rate: 12.71, annual_salary: null, contracted_hours: null, email: null, phone: null,
    };
    const good = fake((i) => (i % 2 === 0 ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${i}`, name: 'propose_add_starter', input }] } : text('Sam is ready for you to confirm.')));
    const passed = await runShiftyEval({ caseIds: ['add-starter'], reps: 2, concurrency: 1, timeoutMinutes: 1, outDir, client: good, log: quiet });
    expect(passed.rows.map((r) => r.pass)).toEqual([true, true]);
    expect(passed.summary).toContain('Overall pass rate: 100%');

    const boastful = fake((i) => (i % 2 === 0 ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${i}`, name: 'propose_add_starter', input }] } : text("I've added Sam Lee.")));
    const failed = await runShiftyEval({ caseIds: ['add-starter'], reps: 1, concurrency: 1, timeoutMinutes: 1, outDir, client: boastful, log: quiet });
    expect(failed.rows[0].pass).toBe(false);
    expect(failed.rows[0].checks.find((c) => c.name === 'not_claimed_done')?.pass).toBe(false);

    const transcript = JSON.parse(await readFile(path.join(outDir, 'transcripts', 'add-starter-0.json'), 'utf8'));
    expect(transcript.turns[0].reply).toBe("I've added Sam Lee.");
    expect((await readFile(path.join(outDir, 'results.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('carries the conversation and the manager\'s decision into the second turn', async () => {
    const outDir = await tmp();
    const sent: unknown[] = [];
    const client = {
      beta: { messages: { create: async (params: { messages: unknown[] }) => { sent.push(structuredClone(params.messages)); return { model: 'claude-opus-5-5', usage, ...text('No, you cancelled it, so Sam is not on the team.') }; } } },
    } as unknown as Anthropic;
    await runShiftyEval({ caseIds: ['cancelled-then-asked'], reps: 1, concurrency: 1, timeoutMinutes: 1, outDir, client, log: quiet });
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).toContain('the manager cancelled');
  });

  it('keeps errors, wrong models and refusals out of the wrong-answer count', async () => {
    const outDir = await tmp();
    const wrongModel = fake(() => ({ model: 'claude-opus-5', ...text('Labour is 15%.') }));
    const a = await runShiftyEval({ caseIds: ['labour-question'], reps: 1, concurrency: 1, timeoutMinutes: 1, outDir, client: wrongModel, log: quiet });
    expect(a.rows).toHaveLength(0);
    expect(a.errors[0]).toMatchObject({ failure: 'served_model_mismatch' });

    const broken = fake(() => new Anthropic.InternalServerError(500, { error: { message: 'overloaded' } }, 'overloaded', new Headers()));
    const b = await runShiftyEval({ caseIds: ['labour-question'], reps: 1, concurrency: 1, timeoutMinutes: 1, outDir, client: broken, log: quiet });
    expect(b.errors[0]).toMatchObject({ failure: 'api_error' });

    const refuses = fake(() => ({ stop_reason: 'refusal', content: [] }));
    const c = await runShiftyEval({ caseIds: ['labour-question'], reps: 1, concurrency: 1, timeoutMinutes: 1, outDir, client: refuses, log: quiet });
    expect(c.rows[0]).toMatchObject({ status: 'refusal', pass: false });
    expect(c.summary).toContain('Refusals 1');
  });
});
