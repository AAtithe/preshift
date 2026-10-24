import { randomUUID } from 'node:crypto';
import { assessShortNotice, DEFAULT_ERA_SETTINGS, snapshot, type EraSettings, type ShortNoticeRecord } from '../src/engine/employmentRights';
import type { Shift } from '../src/engine/types';
import { audit, type EraData, type OrgData } from './store';

export function eraOf(org: OrgData): EraData {
  org.era ??= { shortNotice: [], offers: [] };
  return org.era;
}

export function eraSettings(org: OrgData): EraSettings {
  return { ...DEFAULT_ERA_SETTINGS, ...(org.era?.settings ?? {}) };
}

/**
 * Writes the worker asked for, or that end the job, are not the employer changing a shift at short
 * notice: approving a swap, holiday or time off they requested, sickness they reported, a leaver.
 */
export function exemptFromShortNotice(url: string): boolean {
  return /^\/v1\/(requests|staff|employees)(\/|\?|$)/.test(url);
}

const same = (a: Shift, b: Shift) =>
  a.employeeId === b.employeeId && a.date === b.date && a.startMinute === b.startMinute && a.endMinute === b.endMinute && a.breakMinutes === b.breakMinutes;

/**
 * After a write, checks every shift the worker had been shown (published, or already on the short
 * notice log) against what it is now. A change inside the notice window that takes time away is
 * logged against what the worker was first told; a later edit that gives the time back clears it,
 * unless it has already been paid. Runs on every write, so no route can change a published shift
 * without it being counted.
 */
export function trackShortNotice(org: OrgData, before: Map<string, Shift>, now: Date, actor: string): ShortNoticeRecord[] {
  const settings = eraSettings(org);
  const after = new Map(org.state.shifts.map((s) => [s.id, s]));
  const touched: ShortNoticeRecord[] = [];
  for (const [id, was] of before) {
    const record = org.era?.shortNotice.find((r) => r.shiftId === id && !r.sentIn);
    if (!was.published && !record) continue;
    const is = after.get(id);
    if (is && same(was, is)) continue;
    const original = record?.original ?? snapshot(was);
    const employee = org.state.employees.find((e) => e.id === original.employeeId);
    if (!employee) continue;
    const assessment = assessShortNotice(original, is ? snapshot(is) : null, employee, now, settings);
    const era = eraOf(org);
    const at = now.toISOString();
    if (record) {
      if (!assessment) {
        era.shortNotice = era.shortNotice.filter((r) => r !== record);
        audit(org, actor, 'era.short_notice_cleared', { id: record.id, shiftId: id });
        continue;
      }
      Object.assign(record, { ...assessment, updatedAt: at });
      touched.push(record);
      continue;
    }
    if (!assessment || org.era?.shortNotice.some((r) => r.shiftId === id)) continue;
    const created: ShortNoticeRecord = {
      id: `sn_${randomUUID().slice(0, 10)}`,
      shiftId: id,
      employeeId: employee.id,
      siteId: original.siteId,
      original,
      ...assessment,
      status: 'open',
      createdAt: at,
      updatedAt: at,
      by: actor,
    };
    era.shortNotice.push(created);
    audit(org, actor, 'era.short_notice', { id: created.id, shiftId: id, change: created.change, amount: created.amount, owed: created.owed });
    touched.push(created);
  }
  return touched;
}

/** Short notice pay owed and not yet paid for people a company employs, up to the end of a pay period. */
export function shortNoticeOwed(org: OrgData, entityId: string, periodEnd: string, replaced: Set<string>): ShortNoticeRecord[] {
  return (org.era?.shortNotice ?? []).filter(
    (r) =>
      r.owed &&
      r.status === 'open' &&
      r.amount > 0 &&
      r.original.date <= periodEnd &&
      (!r.sentIn || replaced.has(r.sentIn)) &&
      org.state.employees.find((e) => e.id === r.employeeId)?.entityId === entityId,
  );
}
