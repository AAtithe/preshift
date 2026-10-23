import { describe, expect, it } from 'vitest';
import { newestFirst, NOTIFICATIONS_PER_PERSON, pruneNotifications } from './requests';
import type { StaffNotification } from './types';

const AT = '2026-10-22T12:00:00.000Z';
const note = (id: string, at = AT, employeeId = 'mar-12'): StaffNotification => ({ id, employeeId, kind: 'rota_published', at, title: id, body: '' });

describe('staff notifications in order', () => {
  it('puts the newest first, and of two written in the same millisecond, the one written later', () => {
    const list = [note('older', '2026-10-22T11:00:00.000Z'), note('published'), note('cancelled')];
    expect(newestFirst(list).map((n) => n.id)).toEqual(['cancelled', 'published', 'older']);
  });

  it('drops the oldest when someone has too many, never a newer one tied with it', () => {
    // A hundred and one notifications, every one in the same millisecond: the first written goes.
    const list = Array.from({ length: NOTIFICATIONS_PER_PERSON + 1 }, (_, i) => note(`n${i}`));
    const kept = pruneNotifications(list, AT.slice(0, 10));
    expect(kept).toHaveLength(NOTIFICATIONS_PER_PERSON);
    expect(kept.map((n) => n.id)).not.toContain('n0');
    expect(kept.map((n) => n.id)).toContain(`n${NOTIFICATIONS_PER_PERSON}`);
  });
});
