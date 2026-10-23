import { describe, expect, it } from 'vitest';
import {
  addWorkingMinutes,
  featureOrder,
  isWorkingDay,
  responseDueAt,
  responseOverdue,
  suggestArticles,
  ticketOrder,
  ticketProblem,
  withinRetention,
  type SupportTicket,
} from './support';

const ticket = (over: Partial<SupportTicket> = {}): SupportTicket => ({
  id: 'tkt_1',
  kind: 'question',
  title: 'How do I',
  detail: 'Something or other',
  status: 'new',
  raisedAt: '2026-10-23T15:00:00.000Z', // a Friday
  raisedBy: 'gm@example.com',
  comments: [],
  ...over,
});

describe('support', () => {
  it('counts every target in London working hours, so a weekend waits for Monday morning', () => {
    // Friday 23 October, 16:00 in London (BST). An hour and a half is left that day; the rest runs from Monday 09:00 (GMT by then).
    expect(responseDueAt(ticket({ kind: 'bug', severity: 'blocking' }))).toBe('2026-10-26T11:30:00.000Z');
    expect(responseDueAt(ticket())).toBe('2026-10-26T16:00:00.000Z');
    expect(responseDueAt(ticket({ kind: 'bug', severity: 'minor' }))).toBe('2026-10-28T16:00:00.000Z');
    // A blocking bug on a Saturday night is first thing Monday: four hours from opening.
    expect(responseDueAt(ticket({ kind: 'bug', severity: 'blocking', raisedAt: '2026-10-24T21:00:00Z' }))).toBe('2026-10-26T13:00:00.000Z');
    // Inside the working day, it is simply four hours.
    expect(responseDueAt(ticket({ kind: 'bug', severity: 'blocking', raisedAt: '2026-10-27T10:00:00Z' }))).toBe('2026-10-27T14:00:00.000Z');
  });

  it('skips bank holidays, the Christmas substitute day included', () => {
    expect(isWorkingDay('2026-12-25')).toBe(false);
    expect(isWorkingDay('2026-12-28')).toBe(false);
    expect(isWorkingDay('2026-12-29')).toBe(true);
    // Christmas Eve after closing: Friday is Christmas Day, then the weekend, then Monday's substitute day.
    expect(addWorkingMinutes(new Date('2026-12-24T17:45:00Z'), 240).toISOString()).toBe('2026-12-29T13:00:00.000Z');
  });

  it('keeps London time across the clocks changing', () => {
    // 08:30 BST on 23 October, before opening: the clock starts at 09:00 London, 08:00 UTC.
    expect(addWorkingMinutes(new Date('2026-10-23T07:30:00Z'), 60).toISOString()).toBe('2026-10-23T09:00:00.000Z');
  });

  it('is overdue only while open and unanswered past its target', () => {
    const t = ticket({ kind: 'bug', severity: 'blocking' });
    const late = new Date('2026-10-26T12:00:00Z');
    expect(responseOverdue(t, new Date('2026-10-26T11:00:00Z'))).toBe(false);
    expect(responseOverdue(t, late)).toBe(true);
    expect(responseOverdue({ ...t, firstResponseAt: '2026-10-26T10:00:00Z' }, late)).toBe(false);
    expect(responseOverdue({ ...t, status: 'resolved' }, late)).toBe(false);
  });

  it('puts open blocking bugs first and closed tickets last', () => {
    const list = [
      ticket({ id: 'closed', kind: 'bug', severity: 'blocking', status: 'resolved' }),
      ticket({ id: 'idea', kind: 'feature' }),
      ticket({ id: 'minor', kind: 'bug', severity: 'minor', raisedAt: '2026-10-20T09:00:00Z' }),
      ticket({ id: 'blocking', kind: 'bug', severity: 'blocking' }),
    ];
    expect(list.sort(ticketOrder).map((t) => t.id)).toEqual(['blocking', 'minor', 'idea', 'closed']);
  });

  it('ranks ideas by votes, then by the hours they would save', () => {
    const list = [
      ticket({ id: 'a', kind: 'feature', votes: ['x'], hoursSavedPerWeek: 10 }),
      ticket({ id: 'b', kind: 'feature', votes: ['x', 'y'] }),
      ticket({ id: 'c', kind: 'feature', votes: ['z'], hoursSavedPerWeek: 2 }),
    ];
    expect(list.sort(featureOrder).map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('finds the help article for the words an operator uses', () => {
    expect(suggestArticles('why is publish greyed out')[0].id).toBe('publish-blocked');
    expect(suggestArticles('staff cannot clock in, says outside the geofence')[0].id).toBe('cannot-clock');
    expect(suggestArticles('hours not arrived in teampay')[0].id).toBe('hours-to-payroll');
    expect(suggestArticles('')).toEqual([]);
    expect(suggestArticles('banana')).toEqual([]);
  });

  it('asks for enough to act on', () => {
    expect(ticketProblem({ kind: 'question', title: 'Hi', detail: 'Something useful here' })).toMatch(/title/);
    expect(ticketProblem({ kind: 'question', title: 'Holiday year', detail: 'short' })).toMatch(/more/);
    expect(ticketProblem({ kind: 'bug', title: 'Labour wrong', detail: 'Labour % did not move' })).toMatch(/stops/);
    expect(ticketProblem({ kind: 'bug', title: 'Labour wrong', detail: 'Labour % did not move', impact: 'workaround' })).toBeNull();
  });

  it('keeps closed tickets two years after closing, and open ones for good', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const kept = withinRetention(
      [
        ticket({ id: 'open-old', raisedAt: '2023-01-01T00:00:00Z' }),
        ticket({ id: 'closed-recent', status: 'resolved', resolvedAt: '2025-01-01T00:00:00Z' }),
        ticket({ id: 'closed-old', status: 'declined', resolvedAt: '2024-10-21T00:00:00Z' }),
      ],
      now,
    );
    expect(kept.map((t) => t.id)).toEqual(['open-old', 'closed-recent']);
  });
});
