import type { Change, Command } from '../src/shared/commands';
import { applyChange, inWeek } from '../src/shared/commands';
import { checkClockIn, endClock, startClock } from '../src/engine/clocking';
import { checkWeek } from '../src/engine/compliance';
import { seedDemo } from '../src/engine/simulate';
import type { RotaState, Shift } from '../src/engine/types';
import type { SessionUser } from './auth';
import type { Tx } from './db';
import { can, type Permission } from './permissions';
import { audit, loadState, removeById, replaceAll, upsert } from './repo';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CommandContext {
  tx: Tx;
  user: SessionUser;
  now: { date: string; minute: number };
  allowDemoSeed: boolean;
}

/** JSON with object keys sorted: Postgres stores jsonb keys in its own order, so plain JSON strings differ for equal objects. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}

const forbid = () => new HttpError(403, 'You do not have permission to do that.');

function need(user: SessionUser, permission: Permission, siteId?: string) {
  if (!can(user.membership, permission, siteId)) throw forbid();
}

function shiftIn(state: RotaState, id: string): Shift {
  const shift = state.shifts.find((s) => s.id === id);
  if (!shift) throw new HttpError(404, 'No such shift.');
  return shift;
}

/**
 * Runs one command for one user inside their organisation's transaction:
 * check the permission for the site it touches, apply the engine's rules
 * where the server must be the authority (compliance on publish, the clock,
 * geofence and window on clock-in), write, and record who did it. Returns the
 * changes for the browser to apply.
 */
export async function execute(ctx: CommandContext, cmd: Command): Promise<Change[]> {
  const { tx, user } = ctx;
  const orgId = user.organisationId;
  const state = await loadState(tx);
  const record = (siteId: string | null, detail: unknown) => audit(tx, orgId, user.userId, cmd.type, siteId, detail);

  switch (cmd.type) {
    case 'upsertShift': {
      need(user, 'rota.edit', cmd.shift.siteId);
      const existing = state.shifts.find((s) => s.id === cmd.shift.id);
      if (existing) need(user, 'rota.edit', existing.siteId);
      // Any edit unpublishes the shift: the team sees it again only when it is republished.
      const shift = { ...cmd.shift, published: false };
      await upsert(tx, orgId, 'shifts', [shift]);
      await record(shift.siteId, { before: existing ?? null, after: shift });
      return [{ type: 'upsertShift', shift }];
    }
    case 'deleteShift': {
      const shift = shiftIn(state, cmd.id);
      need(user, 'rota.edit', shift.siteId);
      await removeById(tx, 'shifts', [shift.id]);
      await record(shift.siteId, { before: shift });
      return [{ type: 'deleteShift', id: shift.id }];
    }
    case 'replaceWeek':
    case 'clearWeek': {
      need(user, 'rota.edit', cmd.siteId);
      // A new build starts as a draft until it is published.
      const shifts = cmd.type === 'replaceWeek' ? cmd.shifts.map((s) => ({ ...s, published: s.published ?? false })) : [];
      if (shifts.some((s) => !inWeek(s, cmd.siteId, cmd.weekStart))) throw new HttpError(400, 'Every shift must be in that site and week.');
      const old = state.shifts.filter((s) => inWeek(s, cmd.siteId, cmd.weekStart));
      await removeById(tx, 'shifts', old.map((s) => s.id));
      await upsert(tx, orgId, 'shifts', shifts);
      await record(cmd.siteId, { weekStart: cmd.weekStart, removed: old.length, added: shifts.length });
      return [{ type: 'replaceWeek', siteId: cmd.siteId, weekStart: cmd.weekStart, shifts }];
    }
    case 'publishWeek': {
      need(user, 'rota.publish', cmd.siteId);
      // The same rule as the screen, enforced here so it cannot be skipped.
      const blocks = checkWeek(state, cmd.weekStart, cmd.siteId).filter((i) => i.severity === 'block');
      if (blocks.length) throw new HttpError(409, `${blocks.length} blocking compliance issue${blocks.length > 1 ? 's' : ''}: ${blocks[0].message}`);
      const change: Change = { type: 'publishWeek', siteId: cmd.siteId, weekStart: cmd.weekStart };
      const after = applyChange(state, change).shifts.filter((s) => inWeek(s, cmd.siteId, cmd.weekStart));
      await upsert(tx, orgId, 'shifts', after);
      await record(cmd.siteId, { weekStart: cmd.weekStart, shifts: after.length });
      return [change];
    }
    case 'applyCut': {
      const shift = shiftIn(state, cmd.shiftId);
      need(user, 'cut.apply', shift.siteId);
      if (cmd.endMinute > shift.endMinute || cmd.endMinute < shift.startMinute) throw new HttpError(400, 'A cut can only shorten the shift.');
      const cut = { ...shift, endMinute: cmd.endMinute, breakMinutes: cmd.breakMinutes };
      await upsert(tx, orgId, 'shifts', [cut]);
      await record(shift.siteId, { before: shift, after: cut });
      return [{ type: 'upsertShift', shift: cut }];
    }
    case 'clockIn': {
      const self = cmd.employeeId === user.membership.employeeId;
      need(user, self ? 'clock.self' : 'clock.others', cmd.siteId);
      // Staff clock themselves in on site; only a manager may clock someone in without a location.
      if (!cmd.position && !can(user.membership, 'clock.others', cmd.siteId)) throw new HttpError(400, 'Location is needed to clock in.');
      const { date, minute } = ctx.now;
      const check = checkClockIn(state, cmd.employeeId, cmd.siteId, date, minute, cmd.position);
      if (!check.ok) throw new HttpError(409, check.reason);
      const employee = state.employees.find((e) => e.id === cmd.employeeId)!;
      const clock = startClock(cmd.employeeId, cmd.siteId, employee.roleIds[0], date, minute, check.shift, cmd.position ? 'geofence' : 'manager');
      await upsert(tx, orgId, 'clocks', [clock]);
      await record(cmd.siteId, { clock, warnings: check.warnings });
      return [{ type: 'putClock', clock }];
    }
    case 'clockOut': {
      const open = state.clocks.find((c) => c.id === cmd.id);
      if (!open) throw new HttpError(404, 'No such clocking.');
      if (open.clockOut !== undefined) throw new HttpError(409, 'Already clocked out.');
      need(user, open.employeeId === user.membership.employeeId ? 'clock.self' : 'clock.others', open.siteId);
      const minute = ctx.now.date === open.date ? ctx.now.minute : ctx.now.minute + 1440;
      const clock = endClock(open, minute, cmd.breakMinutes);
      await upsert(tx, orgId, 'clocks', [clock]);
      await record(open.siteId, { clock });
      return [{ type: 'putClock', clock }];
    }
    case 'approveClocks': {
      const clocks = state.clocks.filter((c) => cmd.ids.includes(c.id));
      for (const c of clocks) need(user, 'clock.approve', c.siteId);
      const approved = clocks.map((c) => ({ ...c, approved: true }));
      await upsert(tx, orgId, 'clocks', approved);
      for (const siteId of new Set(clocks.map((c) => c.siteId))) {
        await record(siteId, { ids: approved.filter((c) => c.siteId === siteId).map((c) => c.id) });
      }
      return [{ type: 'approveClocks', ids: approved.map((c) => c.id) }];
    }
    case 'updateTroncScheme': {
      const before = state.troncSchemes.find((t) => t.siteId === cmd.scheme.siteId);
      if (!before) throw new HttpError(404, 'No tronc scheme for that site.');
      // The allocation is the troncmaster's; everything else about the scheme is the business's.
      const allocation = new Set(['pointsPerHour', 'departmentShares']);
      const changed = (Object.keys({ ...before, ...cmd.scheme }) as (keyof typeof before)[]).filter(
        (k) => stable(before[k]) !== stable(cmd.scheme[k]),
      );
      if (changed.some((k) => allocation.has(k))) need(user, 'tronc.edit', cmd.scheme.siteId);
      if (changed.some((k) => !allocation.has(k))) need(user, 'tronc.policy', cmd.scheme.siteId);
      await upsert(tx, orgId, 'troncSchemes', [cmd.scheme]);
      // The record the Act and HMRC look for: who changed the allocation, from what, to what.
      await record(cmd.scheme.siteId, { before, after: cmd.scheme });
      return [{ type: 'updateTroncScheme', scheme: cmd.scheme }];
    }
    case 'markTipsPaid': {
      need(user, 'tips.markPaid', cmd.siteId);
      const change: Change = { type: 'markTipsPaid', siteId: cmd.siteId, weekStart: cmd.weekStart, date: ctx.now.date };
      const changed = applyChange(state, change).tips.filter((t, i) => t.paidOn !== state.tips[i].paidOn);
      await upsert(tx, orgId, 'tips', changed);
      await record(cmd.siteId, { weekStart: cmd.weekStart, tips: changed.length, total: changed.reduce((s, t) => s + t.amount, 0) });
      return [change];
    }
    case 'seedDemo': {
      need(user, 'org.seedDemo');
      if (!ctx.allowDemoSeed) throw new HttpError(403, 'Demo data is switched off on this server.');
      const demo = seedDemo(ctx.now.date, ctx.now.minute);
      await replaceAll(tx, orgId, demo);
      await record(null, { loaded: 'demo' });
      return [{ type: 'replaceState', state: demo }];
    }
  }
}
