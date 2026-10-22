import { describe, expect, it } from 'vitest';
import { importBookings, parseCsv, parseDateTime, parseTime } from './bookingImport';

describe('reading booking exports', () => {
  it('reads a ResDiary-style export and never touches the personal columns', () => {
    const csv = [
      'Booking Reference,Visit Date,Visit Time,Covers,Status,Customer Name,Phone,Email,Notes,Date Booked',
      'RD1001,24/10/2026,19:30,4,Confirmed,Jane Smith,07700900123,jane@example.com,"Birthday, window table",02/10/2026',
      'RD1002,24/10/2026,7:45pm,2,Cancelled,John Doe,07700900456,john@example.com,,01/10/2026',
      'RD1003,24/10/2026,12:00,6,Seated,Ann Lee,07700900789,ann@example.com,,20/10/2026',
    ].join('\r\n');
    const result = importBookings(csv, 'mar', 'resdiary');
    expect(result.columns).toMatchObject({ ref: 'Booking Reference', date: 'Visit Date', time: 'Visit Time', covers: 'Covers', status: 'Status', created: 'Date Booked' });
    expect(result.ignored).toEqual(['Customer Name', 'Phone', 'Email', 'Notes']);
    expect(result.rows).toEqual([
      { id: 'resdiary:RD1001', siteId: 'mar', source: 'resdiary', date: '2026-10-24', startMinute: 1170, covers: 4, status: 'booked', createdAt: '2026-10-02', cancelledAt: undefined },
      { id: 'resdiary:RD1002', siteId: 'mar', source: 'resdiary', date: '2026-10-24', startMinute: 1185, covers: 2, status: 'cancelled', createdAt: '2026-10-01', cancelledAt: undefined },
      { id: 'resdiary:RD1003', siteId: 'mar', source: 'resdiary', date: '2026-10-24', startMinute: 720, covers: 6, status: 'completed', createdAt: '2026-10-20', cancelledAt: undefined },
    ]);
    expect(JSON.stringify(result.rows)).not.toMatch(/Jane|0770|example\.com|Birthday/);
  });

  it('reads a SevenRooms-style export with a combined date and time, semicolons and a cancellation date', () => {
    const csv = ['Reservation ID;Date;Party Size;Status;Created;Cancelled At;Client Name', 'abc;Sat 24 Oct 2026 19:00;8;No Show;2026-10-01T09:15:00Z;;X', 'def;Sat 24 Oct 2026 20:00;2;Canceled;2026-10-01;2026-10-20;Y'].join('\n');
    const result = importBookings(csv, 'mar', 'sevenrooms');
    expect(result.rows.map((r) => [r.id, r.date, r.startMinute, r.covers, r.status, r.createdAt, r.cancelledAt])).toEqual([
      ['sevenrooms:abc', '2026-10-24', 1140, 8, 'no_show', '2026-10-01', undefined],
      ['sevenrooms:def', '2026-10-24', 1200, 2, 'cancelled', '2026-10-01', '2026-10-20'],
    ]);
  });

  it('gives bookings without a reference ids that match on a second import of the same file', () => {
    const csv = ['Date,Time,Guests', '2026-10-24,19:00,2', '2026-10-24,19:00,2', '2026-10-24,19:30,4'].join('\n');
    const once = importBookings(csv, 'mar', 'opentable').rows.map((r) => r.id);
    expect(new Set(once).size).toBe(3);
    expect(importBookings(csv, 'mar', 'opentable').rows.map((r) => r.id)).toEqual(once);
  });

  it('skips what it cannot read, and waitlist entries, saying why', () => {
    const csv = ['Date,Time,Covers,Status', 'tomorrow,19:00,2,', '24/10/2026,,2,', '24/10/2026,19:00,lots,', '24/10/2026,19:00,2,Waitlist', '24/10/2026,19:00,3,'].join('\n');
    const result = importBookings(csv, 'mar', 'other');
    expect(result.rows).toHaveLength(1);
    expect(result.skipped.map((s) => s.line)).toEqual([2, 3, 4, 5]);
    expect(result.skipped[3].reason).toBe('Not a booking (Waitlist)');
  });

  it('says plainly when the columns it needs are missing', () => {
    expect(importBookings('Name,Phone\nA,1', 'mar', 'other').skipped[0].reason).toMatch(/date column and a covers/);
  });

  it('reads UK dates by default and US dates when asked', () => {
    expect(parseDateTime('03/04/2026')).toEqual({ date: '2026-04-03' });
    expect(parseDateTime('03/04/2026', true)).toEqual({ date: '2026-03-04' });
    expect(parseDateTime('24-10-26 19:15')).toEqual({ date: '2026-10-24', minute: 1155 });
    expect(parseDateTime('24th October 2026')).toEqual({ date: '2026-10-24' });
    expect(parseDateTime('2026-10-24T18:30:00Z')).toEqual({ date: '2026-10-24', minute: 1170 });
    expect(parseDateTime('31/02/2026')).toBeNull();
    expect(parseDateTime('99/99/2026')).toBeNull();
    expect([parseTime('7pm'), parseTime('12:00 am'), parseTime('1930'), parseTime('19.30')]).toEqual([1140, 0, 1170, 1170]);
  });

  it('handles quotes, doubled quotes and line breaks inside quotes', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']]);
  });
});
