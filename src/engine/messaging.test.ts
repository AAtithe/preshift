import { describe, expect, it } from 'vitest';
import { emptyMessaging, inQuiet, minutesToQuietEnd, normalisePhone, routeFor, trimMessaging, weekNotice, weekSignature, type Message } from './messaging';

describe('phone numbers', () => {
  it('takes UK mobiles as people type them and refuses landlines', () => {
    expect(normalisePhone('07700 900123')).toBe('+447700900123');
    expect(normalisePhone('+44 (0)7700 900123')).toBe('+447700900123');
    expect(normalisePhone('0044 7700-900-123')).toBe('+447700900123');
    expect(normalisePhone('+353 85 123 4567')).toBe('+353851234567');
    expect(normalisePhone('020 7946 0000')).toBeNull();
    expect(normalisePhone('+442079460000')).toBeNull();
    expect(normalisePhone('call me')).toBeNull();
  });
});

describe('quiet hours', () => {
  it('runs 22:00 to 07:00 by default, across midnight, and can be switched off', () => {
    expect(inQuiet(undefined, 23 * 60)).toBe(true);
    expect(inQuiet(undefined, 6 * 60 + 59)).toBe(true);
    expect(inQuiet(undefined, 7 * 60)).toBe(false);
    expect(inQuiet({ quiet: null }, 3 * 60)).toBe(false);
    expect(inQuiet({ quiet: { start: 13 * 60, end: 14 * 60 } }, 13 * 60 + 30)).toBe(true);
    expect(minutesToQuietEnd(undefined, 23 * 60)).toBe(8 * 60);
  });
});

describe('routing', () => {
  const connected = new Set(['whatsapp', 'sms', 'email'] as const);
  it('uses only channels the organisation connected and the person agreed to, in their order', () => {
    const prefs = { channels: ['whatsapp', 'sms', 'email'] as ('whatsapp' | 'sms' | 'email')[], phone: '+447700900123', smsConsentAt: '2026-10-01', updatedAt: '' };
    const r = routeFor(prefs, { connected: new Set(connected), email: 'ben@example.com' });
    expect(r.order).toEqual(['sms', 'email']);
    expect(r.unusable).toEqual([{ channel: 'whatsapp', reason: 'No WhatsApp number agreed by the person' }]);
    expect(routeFor(prefs, { connected: new Set(['email'] as const), email: undefined }).order).toEqual([]);
  });
});

describe('rota notices', () => {
  const shift = (date: string, startMinute: number, endMinute: number) => ({ date, startMinute, endMinute, siteName: 'Marylebone', roleName: 'Bar' });
  it('lists the week in order and says when it is a change', () => {
    const shifts = [shift('2026-10-21', 17 * 60, 23 * 60), shift('2026-10-19', 10 * 60, 16 * 60)];
    const first = weekNotice('Ben Carter', '2026-10-19', shifts, '');
    expect(first.split('\n')).toEqual([
      'Hi Ben, your rota for the week of Mon 19 Oct is out:',
      'Mon 19 Oct: 10:00 to 16:00, Bar, Marylebone',
      'Wed 21 Oct: 17:00 to 23:00, Bar, Marylebone',
      'Reply here or in the Preshift app if anything is wrong.',
    ]);
    expect(weekNotice('Ben Carter', '2026-10-19', shifts, 'before')).toMatch(/^Hi Ben, your shifts for the week of Mon 19 Oct have changed/);
    expect(weekNotice('Ben Carter', '2026-10-19', [], 'before')).toMatch(/taken off the rota/);
    expect(weekSignature(shifts)).toBe(weekSignature([...shifts].reverse()));
  });
});

describe('retention', () => {
  it('drops messages after 13 months and the threads left empty', () => {
    const data = emptyMessaging();
    data.conversations = [
      { id: 'a', kind: 'direct', siteId: 'mar', employeeId: 'x', createdAt: '', createdBy: '', lastAt: '' },
      { id: 'b', kind: 'direct', siteId: 'mar', employeeId: 'y', createdAt: '', createdBy: '', lastAt: '' },
    ];
    const m = (conversationId: string, at: string): Message => ({ id: at, conversationId, at, from: { kind: 'staff', name: 'x' }, body: 'hi', via: 'app', deliveries: [] });
    data.messages = [m('a', '2025-08-01T00:00:00Z'), m('b', '2026-10-01T00:00:00Z')];
    data.reads['a|staff:x'] = '2025-08-02T00:00:00Z';
    expect(trimMessaging(data, new Date('2026-10-21T00:00:00Z'))).toBe(1);
    expect(data.conversations.map((c) => c.id)).toEqual(['b']);
    expect(data.reads).toEqual({});
  });
});
