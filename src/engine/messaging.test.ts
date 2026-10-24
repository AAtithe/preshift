import { describe, expect, it } from 'vitest';
import { emptyMessaging, inQuiet, minutesToQuietEnd, normalisePhone, routeFor, trimMessaging, type Message } from './messaging';

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

  it('keeps messages longer where the organisation sets a longer period', () => {
    const data = emptyMessaging();
    data.conversations = [
      { id: 'a', kind: 'direct', siteId: 'mar', employeeId: 'x', createdAt: '', createdBy: '', lastAt: '' },
      { id: 'b', kind: 'direct', siteId: 'mar', employeeId: 'y', createdAt: '', createdBy: '', lastAt: '' },
    ];
    const m = (conversationId: string, at: string): Message => ({ id: at, conversationId, at, from: { kind: 'staff', name: 'x' }, body: 'hi', via: 'app', deliveries: [] });
    data.messages = [m('a', '2023-11-01T00:00:00Z'), m('b', '2025-08-01T00:00:00Z')];
    expect(trimMessaging(data, new Date('2026-10-21T00:00:00Z'), 24)).toBe(1);
    expect(data.conversations.map((c) => c.id)).toEqual(['b']);
  });
});
