import { describe, expect, it } from 'vitest';
import type { Employee, Shift } from '../engine/types';
import { dropBlocker, keyChange, LATEST_END, moveShift, nudgeShift, pasteShift, pixelsToMinutes, resizeShift, sameShift, templateOf } from './drag';

const base: Shift = {
  id: 's1',
  employeeId: 'e1',
  roleId: 'server',
  siteId: 'mar',
  date: '2026-10-21',
  startMinute: 11 * 60,
  endMinute: 15 * 60,
  breakMinutes: 0,
};

const person = (id: string, roleIds: string[]) => ({ id, roleIds }) as Employee;

describe('drag maths', () => {
  it('turns pointer travel into quarter hours', () => {
    expect(pixelsToMinutes(0)).toBe(0);
    expect(pixelsToMinutes(2)).toBe(0);
    expect(pixelsToMinutes(6)).toBe(15);
    expect(pixelsToMinutes(-13)).toBe(-30);
  });

  it('stretches either edge and snaps to 15 minutes', () => {
    expect(resizeShift(base, 'end', 120).endMinute).toBe(17 * 60);
    expect(resizeShift(base, 'start', -60).startMinute).toBe(10 * 60);
    expect(resizeShift({ ...base, endMinute: 15 * 60 + 8 }, 'end', 0).endMinute).toBe(15 * 60 + 15);
  });

  it('never shrinks a shift below an hour or past the day limits', () => {
    expect(resizeShift(base, 'end', -600).endMinute).toBe(12 * 60);
    expect(resizeShift(base, 'start', 600).startMinute).toBe(14 * 60);
    expect(resizeShift(base, 'start', -2000).startMinute).toBe(0);
    expect(resizeShift(base, 'end', 5000).endMinute).toBe(LATEST_END);
  });

  it('nudges a whole shift while keeping its length', () => {
    const later = nudgeShift(base, 15);
    expect([later.startMinute, later.endMinute]).toEqual([11 * 60 + 15, 15 * 60 + 15]);
    const capped = nudgeShift(base, 5000);
    expect(capped.endMinute).toBe(LATEST_END);
    expect(capped.endMinute - capped.startMinute).toBe(4 * 60);
  });

  it('keeps the role when the new person is trained, otherwise uses their primary role', () => {
    expect(moveShift(base, person('e2', ['host', 'server']), '2026-10-22')).toMatchObject({
      employeeId: 'e2',
      date: '2026-10-22',
      roleId: 'server',
    });
    expect(moveShift(base, person('e3', ['bartender']), base.date).roleId).toBe('bartender');
  });

  it('spots a drag that ended where it started', () => {
    expect(sameShift(base, { ...base })).toBe(true);
    expect(sameShift(base, nudgeShift(base, 15))).toBe(false);
  });

  it('blocks drops on leave and outside stated availability', () => {
    const jamie = {
      id: 'e9',
      name: 'Jamie Patel',
      roleIds: ['host'],
      leave: ['2026-10-24'],
      // Thursday to Saturday, 11:00 to 21:00
      availability: [3, 4, 5].map((weekday) => ({ weekday, fromMinute: 11 * 60, toMinute: 21 * 60 })),
    } as Employee;
    const thu = { ...base, date: '2026-10-22' };
    expect(dropBlocker(jamie, thu)).toBeNull();
    expect(dropBlocker(jamie, { ...base, date: '2026-10-21' })).toBe('Jamie is not available on Wednesdays.');
    expect(dropBlocker(jamie, { ...thu, endMinute: 22 * 60 })).toBe('Jamie is only available 11:00-21:00 on Thursdays.');
    expect(dropBlocker(jamie, { ...base, date: '2026-10-24' })).toBe('Jamie is on approved leave that day.');
    expect(dropBlocker({ ...jamie, availability: [], leave: [] }, base)).toBeNull();
  });

  it('maps Alt and arrow keys to the same moves, inside the week and availability', () => {
    const week = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
    const press = (key: string, shiftKey = false) => ({ key, altKey: true, shiftKey });
    expect(keyChange({ key: 'ArrowRight', altKey: false, shiftKey: false }, base, week, undefined)).toBeNull();
    expect(keyChange(press('ArrowRight'), base, week, undefined)?.next.date).toBe('2026-10-22');
    expect(keyChange(press('ArrowLeft'), { ...base, date: '2026-10-19' }, week, undefined)).toBeNull();
    expect(keyChange(press('ArrowDown'), base, week, undefined)?.next.startMinute).toBe(11 * 60 + 15);
    expect(keyChange(press('ArrowDown', true), base, week, undefined)?.next).toMatchObject({ startMinute: 11 * 60, endMinute: 15 * 60 + 15 });
    const offWeds = { id: 'e1', name: 'Sam Lee', leave: [], availability: [{ weekday: 1, fromMinute: 0, toMinute: 1440 }] } as unknown as Employee;
    expect(keyChange(press('ArrowRight'), { ...base, date: '2026-10-20' }, week, offWeds)?.reason).toBe('Sam is not available on Wednesdays.');
  });
});

describe('copy and paste', () => {
  it('drops a copied shift on another person and day with its times, break and role', () => {
    const t = templateOf({ ...base, breakMinutes: 20, areaId: 'mar-foh' }, 'Server');
    const pasted = pasteShift(t, person('e2', ['host', 'server']), '2026-10-23', 'mar', 'new');
    expect(pasted).toEqual({ id: 'new', employeeId: 'e2', roleId: 'server', siteId: 'mar', date: '2026-10-23', startMinute: 11 * 60, endMinute: 15 * 60, breakMinutes: 20, areaId: 'mar-foh' });
    expect(pasted.published).toBeUndefined();
  });

  it("falls back to the person's own role, and its area, when they are not trained for the copied one", () => {
    const pasted = pasteShift(templateOf({ ...base, areaId: 'mar-foh' }, 'Server'), person('e3', ['chef']), '2026-10-23', 'mar', 'new');
    expect(pasted.roleId).toBe('chef');
    expect(pasted.areaId).toBeUndefined();
  });

  it('builds from a shift type with no role in the role the person works', () => {
    const pasted = pasteShift({ label: 'Double', startMinute: 600, endMinute: 1380, breakMinutes: 60 }, person('e4', ['bar']), '2026-10-24', 'mar', 'new');
    expect(pasted).toMatchObject({ roleId: 'bar', startMinute: 600, endMinute: 1380, breakMinutes: 60 });
  });
});
