import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { checkWeek } from '../engine/compliance';
import { seedState } from '../engine/seed';
import { runRotaAgent, RotaAgentError } from './rotaAgent';
import { executeRotaTool, ROTA_TOOLS, type RotaDraft } from './rotaTools';

const WEEK = '2026-10-19'; // a Monday; seed leave for Chloe falls on the Wednesday
const draft = (): RotaDraft => ({ state: seedState(WEEK), siteId: 'mar', weekStart: WEEK });
const add = (d: RotaDraft, employee_id: string, date: string, start: string, end: string, role_id = 'server') =>
  executeRotaTool(d, 'add_shift', { employee_id, role_id, date, start, end });

describe('rota tools', () => {
  it('adds a legal shift with the statutory break and reports what it costs', () => {
    const d = draft();
    const out = add(d, 'mar-8', '2026-10-23', '12:00', '20:00');
    expect(out.isError).toBeFalsy();
    const shift = d.state.shifts[0];
    expect(shift.breakMinutes).toBe(20);
    expect((out.result as { cost_added: number }).cost_added).toBeGreaterThan(0);
  });

  it('refuses a shift on approved leave and leaves the draft untouched', () => {
    const d = draft();
    const out = add(d, 'mar-13', '2026-10-21', '17:00', '23:00', 'bar');
    expect(out.isError).toBe(true);
    expect(out.result).toMatchObject({ refused: true });
    expect(d.state.shifts).toHaveLength(0);
  });

  it('refuses more than 8 hours a day for an under 18', () => {
    const d = draft();
    const out = add(d, 'mar-11', '2026-10-24', '11:00', '21:00', 'host');
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toContain('Under 18s');
  });

  it('refuses a double booking made by moving a shift onto another', () => {
    const d = draft();
    add(d, 'mar-8', '2026-10-23', '12:00', '16:00');
    add(d, 'mar-15', '2026-10-23', '15:00', '20:00');
    const moving = d.state.shifts.find((s) => s.employeeId === 'mar-15')!;
    const out = executeRotaTool(d, 'update_shift', { shift_id: moving.id, employee_id: 'mar-8', start: null, end: null });
    expect(out.isError).toBe(true);
    expect(d.state.shifts.find((s) => s.id === moving.id)!.employeeId).toBe('mar-15');
  });

  it('cannot move a shift a manager overrode for short rest', () => {
    const d = draft();
    // The assistant refuses to make this breach, so it is set up as a manager would have rostered it.
    add(d, 'mar-8', '2026-10-22', '15:00', '23:30');
    d.state.shifts.push({ ...d.state.shifts[0], id: 'morning', date: '2026-10-23', startMinute: 7 * 60, endMinute: 11 * 60, breakMinutes: 0 });
    const breach = checkWeek(d.state, WEEK).find((i) => i.code === 'daily-rest')!;
    d.state.restOverrides = [{ id: 'o1', employeeId: 'mar-8', code: 'daily-rest', key: breach.overrideKey!, reason: 'Covering sickness', by: 'gm', at: '' }];
    const morning = d.state.shifts.find((s) => s.date === '2026-10-23')!;
    const out = executeRotaTool(d, 'update_shift', { shift_id: morning.id, employee_id: null, start: '06:30', end: null });
    expect(out.isError).toBe(true);
    expect(d.state.shifts.find((s) => s.id === morning.id)!.startMinute).toBe(7 * 60);
  });

  it('handles shifts past midnight and rejects bad input without throwing', () => {
    const d = draft();
    add(d, 'mar-8', '2026-10-24', '18:00', '00:30');
    expect(d.state.shifts[0].endMinute).toBe(24 * 60 + 30);
    expect(add(d, 'nobody', '2026-10-24', '12:00', '16:00').isError).toBe(true);
    expect(add(d, 'mar-8', '2026-11-30', '12:00', '16:00').isError).toBe(true);
    expect(add(d, 'mar-8', '2026-10-25', '9am', '16:00').isError).toBe(true);
  });

  it('builds from the forecast, honours exclusions, and never creates a blocking issue', () => {
    const d = draft();
    executeRotaTool(d, 'build_from_forecast', { exclude_employee_ids: ['mar-12'] });
    expect(d.state.shifts.length).toBeGreaterThan(20);
    expect(d.state.shifts.some((s) => s.employeeId === 'mar-12')).toBe(false);
    expect(checkWeek(d.state, WEEK, 'mar').filter((i) => i.severity === 'block')).toEqual([]);
  });

  it('reports status the model can act on', () => {
    const d = draft();
    const status = executeRotaTool(d, 'get_rota_status', {}).result as { labour_target_pct: number; days: { cover: unknown[] }[] };
    expect(status.labour_target_pct).toBe(28);
    expect(status.days).toHaveLength(7);
    expect(status.days[0].cover.length).toBeGreaterThan(0); // an empty week is short everywhere
  });

  it('declares closed schemas with every field required', () => {
    for (const tool of ROTA_TOOLS) {
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(tool.input_schema.required.sort()).toEqual(Object.keys(tool.input_schema.properties).sort());
    }
  });
});

type Reply = { stop_reason: string; content: unknown[] };

/** A scripted stand-in for the Claude API, recording each request it receives. */
function fakeClient(replies: Reply[]) {
  const requests: { messages: unknown[] }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: { messages: unknown[] }) => {
          requests.push(structuredClone(params));
          const next = replies.shift();
          if (!next) throw new Error('No more scripted replies');
          return next;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

describe('rota agent loop', () => {
  const request = { state: seedState(WEEK), siteId: 'mar', weekStart: WEEK, instruction: 'Cover Friday lunch.', today: WEEK };

  it('runs the tools Claude asks for on a copy and returns the draft with its summary', async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'add_shift', input: { employee_id: 'mar-8', role_id: 'server', date: '2026-10-23', start: '11:00', end: '16:00' } },
          { type: 'tool_use', id: 't2', name: 'add_shift', input: { employee_id: 'mar-13', role_id: 'bar', date: '2026-10-21', start: '17:00', end: '23:00' } },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Oliver covers Friday lunch.' }] },
    ]);
    const steps: string[] = [];
    const result = await runRotaAgent(client, request, (s) => steps.push(s));

    expect(result.summary).toBe('Oliver covers Friday lunch.');
    expect(result.state.shifts).toHaveLength(1);
    expect(request.state.shifts).toHaveLength(0); // live state untouched
    expect(steps[0]).toMatch(/^Added Oliver Hughes Fri 11:00-16:00/);
    expect(steps[1]).toMatch(/^Refused/);

    // Both results go back in one user turn, after the assistant turn replayed unchanged.
    const second = requests[1].messages as { role: string; content: { type: string; is_error?: boolean }[] }[];
    expect(second[1].content[0]).toMatchObject({ type: 'thinking', signature: 'sig' });
    expect(second[2].content.map((b) => b.is_error)).toEqual([undefined, true]);
  });

  it('surfaces refusals and truncation as errors rather than a half-built rota', async () => {
    await expect(runRotaAgent(fakeClient([{ stop_reason: 'refusal', content: [] }]).client, request)).rejects.toBeInstanceOf(RotaAgentError);
    await expect(runRotaAgent(fakeClient([{ stop_reason: 'max_tokens', content: [] }]).client, request)).rejects.toBeInstanceOf(RotaAgentError);
  });
});
