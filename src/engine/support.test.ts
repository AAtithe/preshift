import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  featureOrder,
  responseDueAt,
  responseOverdue,
  suggestArticles,
  ticketOrder,
  ticketProblem,
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
  it('measures blocking bugs on the clock, any day, and the rest in working days', () => {
    expect(responseDueAt(ticket({ kind: 'bug', severity: 'blocking' }))).toBe('2026-10-23T19:00:00.000Z');
    // Friday plus one working day is Monday, not Saturday.
    expect(responseDueAt(ticket())).toBe('2026-10-26T15:00:00.000Z');
    expect(responseDueAt(ticket({ kind: 'bug', severity: 'minor' }))).toBe('2026-10-28T15:00:00.000Z');
    expect(addWorkingDays(new Date('2026-10-24T09:00:00Z'), 1).toISOString()).toBe('2026-10-26T09:00:00.000Z');
  });

  it('is overdue only while open and unanswered past its target', () => {
    const t = ticket({ kind: 'bug', severity: 'blocking' });
    const late = new Date('2026-10-23T20:00:00Z');
    expect(responseOverdue(t, new Date('2026-10-23T18:00:00Z'))).toBe(false);
    expect(responseOverdue(t, late)).toBe(true);
    expect(responseOverdue({ ...t, firstResponseAt: '2026-10-23T16:00:00Z' }, late)).toBe(false);
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
});
