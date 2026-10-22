import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { seedState } from '../engine/seed';
import { autoSchedule } from '../engine/autoschedule';
import { runAppAgent } from './appAgent';
import { executeAppTool, SCREENS, type AppToolContext, type Proposal } from './appTools';
import { NAV_ITEMS } from '../ui/nav';

const WEEK = '2026-10-19';
const ctx = (): AppToolContext => ({
  state: seedState(WEEK),
  siteIds: ['mar'],
  week: WEEK,
  now: { date: WEEK, minute: 9 * 60 },
  loadEntries: async () => [],
});
const idOf = (c: AppToolContext, name: string) => c.state.employees.find((e) => e.name === name)!.id;
const starter = (over: Record<string, unknown> = {}) => ({
  name: 'Sam Lee', site_id: 'mar', role_ids: ['bar'], start_date: '2026-10-26', date_of_birth: '1999-05-01',
  pay_basis: 'hourly', hourly_rate: 12.71, annual_salary: null, contracted_hours: null, email: null, phone: null, ...over,
});

describe('Shifty and command bar tools', () => {
  it('proposes a starter without saving anything, and says they cannot be rostered yet', async () => {
    const c = ctx();
    const before = c.state.employees.length;
    const out = await executeAppTool(c, 'propose_add_starter', starter());
    expect(out.isError).toBeFalsy();
    const p = out.proposal as Extract<Proposal, { kind: 'add_starter' }>;
    expect(p.kind).toBe('add_starter');
    expect(p.employee).toMatchObject({ name: 'Sam Lee', siteId: 'mar', entityId: 'wdl', roleIds: ['bar'], hourlyRate: 12.71, startDate: '2026-10-26', rightToWork: { checked: false } });
    expect(p.warnings.join(' ')).toMatch(/right to work/);
    expect(c.state.employees.length).toBe(before); // nothing happens until the manager confirms
  });

  it('refuses a starter below the minimum wage for their age, or with missing details', async () => {
    const c = ctx();
    expect(JSON.stringify((await executeAppTool(c, 'propose_add_starter', starter({ hourly_rate: 9 }))).result)).toMatch(/below the legal minimum/);
    expect((await executeAppTool(c, 'propose_add_starter', starter({ date_of_birth: '' }))).isError).toBe(true);
    expect((await executeAppTool(c, 'propose_add_starter', starter({ hourly_rate: null }))).isError).toBe(true);
    expect((await executeAppTool(c, 'propose_add_starter', starter({ role_ids: ['astronaut'] }))).isError).toBe(true);
    // A 17 year old on the 16-17 rate is fine, with the young worker limits flagged.
    const young = await executeAppTool(c, 'propose_add_starter', starter({ date_of_birth: '2009-06-01', hourly_rate: 8 }));
    expect(young.isError).toBeFalsy();
    expect(young.proposal!.warnings.join(' ')).toMatch(/Under 18/);
  });

  it('never gives the model HR file details or why someone is off', async () => {
    const c = ctx();
    const oliver = c.state.employees.find((e) => e.id === 'mar-8')!;
    oliver.hr = { niNumber: 'QQ123456C', address: '1 Secret Street' };
    oliver.absences = [{ id: 'a1', type: 'sickness', from: WEEK, to: '2026-10-20', reason: 'Migraine' }];
    const out = JSON.stringify((await executeAppTool(c, 'get_person', { employee_id: 'mar-8' })).result);
    expect(out).not.toMatch(/QQ123456C|Secret Street|Migraine|sickness/);
    expect(out).toContain('2026-10-20'); // the days off are there
  });

  it('refuses a shift the law forbids before it is even proposed', async () => {
    const c = ctx();
    const chloe = idOf(c, 'Chloe Dubois'); // on leave on the Wednesday
    const out = await executeAppTool(c, 'propose_add_shift', { employee_id: chloe, site_id: 'mar', role_id: 'bar', date: '2026-10-21', start: '17:00', end: '23:00' });
    expect(JSON.stringify(out.result)).toMatch(/leave/);
    const past = await executeAppTool(c, 'propose_add_shift', { employee_id: 'mar-8', site_id: 'mar', role_id: 'server', date: WEEK, start: '08:00', end: '12:00' });
    expect(JSON.stringify(past.result)).toMatch(/already started/);
    const ok = await executeAppTool(c, 'propose_add_shift', { employee_id: 'mar-8', site_id: 'mar', role_id: 'server', date: '2026-10-23', start: '12:00', end: '20:00' });
    expect(ok.proposal).toMatchObject({ kind: 'add_shift', shift: { breakMinutes: 20, startMinute: 720, endMinute: 1200 } });
  });

  it('proposes leave, leavers, absences and record changes with what they will do', async () => {
    const c = ctx();
    const leave = await executeAppTool(c, 'propose_leave', { employee_id: 'mar-8', dates: ['2026-10-30', '2026-10-30', '2026-10-31'] });
    expect(leave.proposal).toMatchObject({ kind: 'book_leave', dates: ['2026-10-30', '2026-10-31'] });
    const leaver = await executeAppTool(c, 'propose_leaver', { employee_id: 'mar-8', leave_date: '2026-11-30' });
    expect(leaver.proposal).toMatchObject({ kind: 'mark_leaver', leaveDate: '2026-11-30' });
    const absence = await executeAppTool(c, 'propose_absence', { employee_id: 'mar-8', type: 'sickness', from: '2026-10-19', to: '2026-10-28', reason: null });
    expect(absence.proposal!.warnings.join(' ')).toMatch(/fit note/);
    const raise = await executeAppTool(c, 'propose_update_person', {
      employee_id: 'mar-8', hourly_rate: 13.5, annual_salary: null, contracted_hours: null, max_weekly_hours: null,
      role_ids: null, cover_site_ids: null, email: null, phone: null, rota_notes: 'Prefers lunches',
    });
    expect(raise.proposal).toMatchObject({ kind: 'update_person', employee: { hourlyRate: 13.5, rotaNotes: 'Prefers lunches' } });
    expect((await executeAppTool(c, 'propose_update_person', { employee_id: 'mar-8', hourly_rate: 5 })).isError).toBe(true);
  });

  it('will not publish a week with nothing in it, and finds people by name', async () => {
    const c = ctx();
    expect(JSON.stringify((await executeAppTool(c, 'propose_publish', { site_ids: null, week_start: null })).result)).toMatch(/no shifts/);
    const found = (await executeAppTool(c, 'find_people', { query: 'gra', site_id: null, include_leavers: false })).result as { name: string }[];
    expect(found.map((p) => p.name)).toContain('Grace Mensah');
  });
});

describe('asking for cover from Shifty', () => {
  /** A shift later in the week with people free to cover it. */
  async function coverable(c: AppToolContext) {
    c.state.shifts.push(...autoSchedule(c.state, 'mar', WEEK).added);
    for (const s of c.state.shifts.filter((x) => x.siteId === 'mar' && x.date > WEEK)) {
      const out = await executeAppTool(c, 'propose_ask_cover', { shift_id: s.id, note: null, first_to_accept: null, urgent: null });
      if (!out.isError) return { s, out };
    }
    throw new Error('No coverable shift in the seed');
  }

  it('proposes asking only those who could legally work it, and sends nothing until confirmed', async () => {
    const c = ctx();
    const { s, out } = await coverable(c);
    const p = out.proposal as Extract<Proposal, { kind: 'ask_cover' }>;
    expect(p).toMatchObject({ kind: 'ask_cover', shiftId: s.id, firstToAccept: true, urgent: false, note: null });
    expect(p.employeeIds.length).toBeGreaterThan(0);
    expect(p.employeeIds).not.toContain(s.employeeId);
    const result = out.result as { would_ask: { name: string }[]; not_asked: { why: string }[] };
    expect(result.would_ask.map((w) => w.name)).toEqual(p.employeeIds.map((id) => c.state.employees.find((e) => e.id === id)!.name));
    expect(result.not_asked.every((n) => n.why)).toBe(true);
    // The shift is untouched until the manager confirms.
    expect(c.state.shifts.find((x) => x.id === s.id)!.employeeId).toBe(s.employeeId);
  });

  it('keeps who is off and why out of the note everyone reads', async () => {
    const c = ctx();
    const { s } = await coverable(c);
    const first = c.state.employees.find((e) => e.id === s.employeeId)!.name.split(' ')[0];
    for (const note of [`${first} cannot make it`, 'Off sick today', 'Ben is ill', 'At the hospital']) {
      const out = await executeAppTool(c, 'propose_ask_cover', { shift_id: s.id, note, first_to_accept: null, urgent: null });
      expect(out.isError, note).toBe(true);
    }
    const ok = await executeAppTool(c, 'propose_ask_cover', { shift_id: s.id, note: 'Busy night: Illuminations party of 30 at 7', first_to_accept: false, urgent: true });
    expect(ok.isError).toBeFalsy();
    expect(ok.proposal).toMatchObject({ note: 'Busy night: Illuminations party of 30 at 7', firstToAccept: false, urgent: true });
  });

  it('refuses a shift that has started or does not exist', async () => {
    const c = ctx();
    const started = c.state.shifts.find((x) => x.date < WEEK || (x.date === WEEK && x.startMinute <= 9 * 60));
    if (started) expect((await executeAppTool(c, 'propose_ask_cover', { shift_id: started.id, note: null, first_to_accept: null, urgent: null })).isError).toBe(true);
    expect((await executeAppTool(c, 'propose_ask_cover', { shift_id: 'nope', note: null, first_to_accept: null, urgent: null })).isError).toBe(true);
  });
});

describe('screens Shifty can open', () => {
  it('match the management bar, so a new screen is never out of its reach', () => {
    expect([...SCREENS].sort()).toEqual([...new Set(NAV_ITEMS.map((n) => n.id))].sort());
  });
});

describe('the Shifty agent loop', () => {
  it('collects proposals, tells the model what the manager decided, and keeps the conversation append-only', async () => {
    const sent: { messages: { role: string; content: unknown }[] }[] = [];
    const replies = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'propose_add_starter', input: starter() }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is Sam, ready for you to confirm.' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Great, Sam is set up.' }] },
    ];
    const client = {
      beta: { messages: { create: async (params: { messages: { role: string; content: unknown }[] }) => { sent.push(structuredClone(params)); return { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 10 }, ...replies.shift()! }; } } },
    } as unknown as Anthropic;
    const where = { screen: 'people', scope: 'Marylebone', user: 'gm@ws.example (member)' };
    const first = await runAppAgent(client, { messages: [], text: 'Please add a new starter, Sam Lee', mode: 'command', ctx: ctx(), where });
    expect(first.reply).toBe('Here is Sam, ready for you to confirm.');
    expect(first.proposals.map((p) => p.kind)).toEqual(['add_starter']);
    expect(String(sent[0].messages[0].content)).toMatch(/\[Today 2026-10-19 09:00 UK time\. gm@ws\.example \(member\) is on the people screen, viewing Marylebone/);

    await runAppAgent(client, { messages: first.messages, text: 'Thanks', mode: 'command', ctx: ctx(), where, outcomes: ['the manager confirmed "Add Sam Lee": Added Sam Lee as a starter.'] });
    const last = sent[2].messages;
    expect(last.slice(0, first.messages.length)).toEqual(first.messages);
    expect(String(last.at(-1)!.content)).toMatch(/Since your last reply: the manager confirmed "Add Sam Lee"/);
  });
});
