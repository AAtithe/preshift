import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { checkWeek } from '../engine/compliance';
import { seedState } from '../engine/seed';
import { runRotaAgent, RotaAgentError } from './rotaAgent';
import { executeRotaTool, ROTA_TOOLS, type RotaDraft } from './rotaTools';

const WEEK = '2026-10-19'; // a Monday; seed leave for Chloe falls on the Wednesday
const MONDAY_MORNING = { date: WEEK, minute: 0 }; // nothing in the week has started yet
const draft = (now = MONDAY_MORNING): RotaDraft => ({ state: seedState(WEEK), siteIds: ['mar'], weekStart: WEEK, now });
const idOf = (d: RotaDraft, name: string) => d.state.employees.find((e) => e.name === name)!.id;
const add = (d: RotaDraft, employee_id: string, date: string, start: string, end: string, role_id = 'server') =>
  executeRotaTool(d, 'add_shift', { site_id: 'mar', employee_id, role_id, date, start, end });

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
    executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: ['mar-12'], allow_cover: true });
    expect(d.state.shifts.length).toBeGreaterThan(20);
    expect(d.state.shifts.some((s) => s.employeeId === 'mar-12')).toBe(false);
    expect(checkWeek(d.state, WEEK, 'mar').filter((i) => i.severity === 'block')).toEqual([]);
  });

  it('reports status the model can act on', () => {
    const d = draft();
    const status = executeRotaTool(d, 'get_rota_status', { site_id: null }).result as { sites: { labour_target_pct: number; days: { cover: unknown[] }[] }[] };
    expect(status.sites).toHaveLength(1);
    expect(status.sites[0].labour_target_pct).toBe(28);
    expect(status.sites[0].days).toHaveLength(7);
    expect(status.sites[0].days[0].cover.length).toBeGreaterThan(0); // an empty week is short everywhere
  });

  it('shows cover staff after the home team, with what borrowing them costs, and who can be rostered', () => {
    const d = draft();
    const team = executeRotaTool(d, 'list_team', { site_id: 'mar' }).result as { id: string; name: string; cover: string; right_to_work: string; employed_this_week: unknown }[];
    const cover = (name: string) => team.find((p) => p.name === name)?.cover;
    expect(cover('Grace Mensah')).toBe('home team');
    expect(cover('Yusuf Demir')).toBe('sister site, same company');
    expect(cover('Dev Kapoor')).toBe('another company: intercompany recharge');
    expect(team.findIndex((p) => p.name === 'Dev Kapoor')).toBeGreaterThan(team.findIndex((p) => p.name === 'Grace Mensah'));
    // Someone from another site who has not offered to cover is not offered to the model at all.
    expect(team.some((p) => p.name === 'Hannah Lee')).toBe(false);
    const nadia = team.find((p) => p.name === 'Nadia Haddad')!;
    expect(nadia.right_to_work).toMatch(/cannot be rostered/);
    expect(nadia.employed_this_week).toEqual(['2026-10-24', '2026-10-25']);
  });

  it('refuses someone who has not agreed to cover the site, and a starter with no right to work check', () => {
    const d = draft();
    expect(JSON.stringify(add(d, idOf(d, 'Hannah Lee'), '2026-10-23', '12:00', '18:00').result)).toContain('has not agreed to cover');
    const out = add(d, idOf(d, 'Nadia Haddad'), '2026-10-24', '12:00', '18:00');
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toContain('right to work');
    expect(add(d, idOf(d, 'Dev Kapoor'), '2026-10-23', '17:00', '23:00', 'bar').isError).toBeFalsy();
  });

  it('leaves shifts that have started alone and plans only the hours ahead', () => {
    const before = draft();
    add(before, 'mar-8', '2026-10-19', '12:00', '16:00');
    const monday = before.state.shifts[0];
    // It is now Wednesday at noon.
    const d: RotaDraft = { ...before, now: { date: '2026-10-21', minute: 12 * 60 } };
    expect(JSON.stringify(add(d, 'mar-8', '2026-10-21', '11:00', '15:00').result)).toContain('already started');
    expect(executeRotaTool(d, 'remove_shift', { shift_id: monday.id }).isError).toBe(true);
    expect(executeRotaTool(d, 'update_shift', { shift_id: monday.id, employee_id: null, start: '13:00', end: null }).isError).toBe(true);
    expect(executeRotaTool(d, 'clear_week', { site_id: null }).result).toMatchObject({ removed: 0, kept_because_started: 1 });

    executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: true });
    const added = d.state.shifts.filter((s) => s.id !== monday.id);
    expect(added.length).toBeGreaterThan(10);
    expect(added.every((s) => s.date > '2026-10-21' || (s.date === '2026-10-21' && s.startMinute > 12 * 60))).toBe(true);
    expect(d.state.shifts.find((s) => s.id === monday.id)).toEqual(monday);
  });

  it('can build without borrowing from other sites', () => {
    const d = draft();
    executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: false });
    const home = new Set(d.state.employees.filter((e) => e.siteId === 'mar').map((e) => e.id));
    expect(d.state.shifts.every((s) => home.has(s.employeeId))).toBe(true);
  });

  it('plans several sites together: each home team first, then sharing, and stays inside the sites given', () => {
    const d: RotaDraft = { ...draft(), siteIds: ['mar', 'fitz'] };
    const status = executeRotaTool(d, 'get_rota_status', { site_id: null }).result as { sites: { site_id: string }[]; all_sites: unknown };
    expect(status.sites.map((x) => x.site_id)).toEqual(['mar', 'fitz']);
    expect(status.all_sites).toBeDefined();
    executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: true });
    const sites = new Set(d.state.shifts.map((s) => s.siteId));
    expect([...sites].sort()).toEqual(['fitz', 'mar']);
    expect(checkWeek(d.state, WEEK, ['mar', 'fitz']).filter((i) => i.severity === 'block')).toEqual([]);
    // Shoreditch is not being planned, so nothing can be added there.
    const out = executeRotaTool(d, 'add_shift', { site_id: 'shd', employee_id: 'shd-2', role_id: 'chef', date: '2026-10-23', start: '12:00', end: '18:00' });
    expect(JSON.stringify(out.result)).toContain('not one of the sites being planned');
    // Yusuf is Fitzrovia's and covers Marylebone, so he can be put on at either.
    const yusuf = idOf(d, 'Yusuf Demir');
    const team = executeRotaTool(d, 'list_team', { site_id: 'mar' }).result as { id: string; cover: string }[];
    expect(team.find((p) => p.id === yusuf)?.cover).toBe('sister site, same company');
  });

  it('gives the model each person\'s recent history, notes and holiday, or says plainly it has none', () => {
    const d = draft();
    expect(executeRotaTool(d, 'get_people_insights', { site_id: null }).result).toMatchObject({ available: false });
    d.insights = { 'mar-8': { employeeId: 'mar-8', from: '2026-09-21', to: '2026-10-18', averageWeeklyHours: 31.5, weekendShifts: 8, closingShifts: 6, lateArrivals: 2, noShows: 0, notes: 'No Sunday closes', holiday: { remainingHours: 40, leaveYearEnd: '2026-12-31', daysToYearEnd: 72, shouldPlanLeave: false } } };
    const res = executeRotaTool(d, 'get_people_insights', { site_id: 'mar' }).result as { available: boolean; people: Record<string, unknown>[] };
    expect(res.available).toBe(true);
    expect(res.people.find((p) => p.id === 'mar-8')).toMatchObject({ weekend_shifts: 8, late_arrivals: 2, notes: 'No Sunday closes', holiday_left_hours: 40 });
  });

  it('declares closed schemas with every field required', () => {
    for (const tool of ROTA_TOOLS) {
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(tool.input_schema.required.sort()).toEqual(Object.keys(tool.input_schema.properties).sort());
    }
  });
});

type Reply = { stop_reason: string; content: unknown[]; usage?: Record<string, number> };

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
          return { usage: { input_tokens: 0, output_tokens: 0 }, ...next };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

describe('rota agent loop', () => {
  const request = { state: seedState(WEEK), siteIds: ['mar'], weekStart: WEEK, instruction: 'Cover Friday lunch.', now: MONDAY_MORNING };

  it('runs the tools Claude asks for on a copy and returns the draft with its summary', async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'add_shift', input: { site_id: 'mar', employee_id: 'mar-8', role_id: 'server', date: '2026-10-23', start: '11:00', end: '16:00' } },
          { type: 'tool_use', id: 't2', name: 'add_shift', input: { site_id: 'mar', employee_id: 'mar-13', role_id: 'bar', date: '2026-10-21', start: '17:00', end: '23:00' } },
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

  it('continues a draft with a follow-up, keeping earlier changes, the conversation and the running cost', async () => {
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const first = fakeClient([
      { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't1', name: 'add_shift', input: { site_id: 'mar', employee_id: 'mar-8', role_id: 'server', date: '2026-10-23', start: '11:00', end: '16:00' } }] },
      { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Oliver covers Friday lunch.' }] },
    ] as Reply[]);
    const draft1 = await runRotaAgent(first.client, request);

    const second = fakeClient([
      { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't2', name: 'add_shift', input: { site_id: 'mar', employee_id: 'mar-8', role_id: 'server', date: '2026-10-24', start: '11:00', end: '16:00' } }] },
      { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'And Saturday lunch.' }] },
    ] as Reply[]);
    const draft2 = await runRotaAgent(second.client, { ...request, instruction: 'Same on Saturday.', previous: draft1 });

    expect(draft2.state.shifts.map((s) => s.date)).toEqual(['2026-10-23', '2026-10-24']);
    expect(draft2.instructions).toEqual(['Cover Friday lunch.', 'Same on Saturday.']);
    // The follow-up is appended to the earlier conversation, never a rewrite of it.
    const sent = second.requests[0].messages as { role: string; content: unknown }[];
    expect(sent.slice(0, draft1.messages.length)).toEqual(draft1.messages);
    expect(String(sent[draft1.messages.length].content)).toContain('Same on Saturday.');
    expect(draft2.usage.inputTokens).toBe(4000);
    expect(draft2.usage.costUsd).toBeCloseTo((4000 * 4 + 800 * 20) / 1_000_000);
    expect(draft1.state.shifts).toHaveLength(1); // the earlier draft is not mutated
  });

  it('surfaces refusals and truncation as errors rather than a half-built rota', async () => {
    await expect(runRotaAgent(fakeClient([{ stop_reason: 'refusal', content: [] }]).client, request)).rejects.toBeInstanceOf(RotaAgentError);
    await expect(runRotaAgent(fakeClient([{ stop_reason: 'max_tokens', content: [] }]).client, request)).rejects.toBeInstanceOf(RotaAgentError);
  });
});
