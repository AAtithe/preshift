import { autoSchedule, autoScheduleSites } from '../../engine/autoschedule';
import { checkWeek, type Issue } from '../../engine/compliance';
import { shiftPaidHours } from '../../engine/cost';
import { dayDemand } from '../../engine/demand';
import type { PersonInsight } from '../../engine/insights';
import { weekMetrics } from '../../engine/metrics';
import { hasStarted, type LondonNow } from '../../engine/rotaWeek';
import { seedState } from '../../engine/seed';
import { ageOn, weekDates, weekday } from '../../engine/time';
import type { RotaState, Shift } from '../../engine/types';
import { executeRotaTool, type RotaDraft } from '../rotaTools';

/**
 * The rota assistant's evaluation set. Each case is a realistic request on the demo group, graded on
 * the rota it leaves behind (the end state), never on what it says it did, with atomic pass/fail
 * checks. Every case ships with a reference solution (oracle) that must pass, and a do-nothing
 * answer that must fail unless doing nothing is right; cases.test.ts proves both before any money is
 * spent on a real run (scripts/eval-assistant.ts).
 */

export const WEEK = '2026-10-19'; // a Monday
const MONDAY: LondonNow = { date: WEEK, minute: 0 };
const WEDNESDAY_NOON: LondonNow = { date: '2026-10-21', minute: 12 * 60 };
const SATURDAY = '2026-10-24';
const SUNDAY = '2026-10-25';

export interface EvalSetup {
  state: RotaState;
  insights?: Record<string, PersonInsight>;
}

export interface GradeInput {
  before: RotaState;
  after: RotaState;
  summary: string;
  siteIds: string[];
  now: LondonNow;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface Check {
  name: string;
  run: (g: GradeInput) => { pass: boolean; detail: string };
}

export interface EvalCase {
  id: string;
  description: string;
  siteIds: string[];
  now: LondonNow;
  /** One instruction, or a first request and follow-ups to the same draft. */
  instructions: string[];
  setup: () => EvalSetup;
  checks: Check[];
  /** A reference solution through the same tools the model uses. Returns the note it would write. */
  oracle: (d: RotaDraft) => string;
  /** True only where leaving the rota alone is the right answer. */
  nullPasses?: boolean;
}

// ---- Measures -------------------------------------------------------------------------------

/** Person-hours short of forecast headcount at a site this week: the cover a rota fails to provide. */
export function shortHours(state: RotaState, siteId: string, roleIds?: string[], dates = weekDates(WEEK)): number {
  return state.demandRules
    .filter((r) => r.siteId === siteId && (!roleIds || roleIds.includes(r.roleId)))
    .reduce((sum, r) => sum + dates.reduce((d, date) => d + dayDemand(state, siteId, r.roleId, date).reduce((h, x) => h + Math.max(0, x.gap), 0), 0), 0);
}

const labourPct = (state: RotaState, siteId: string) => weekMetrics(state, siteId, WEEK).labourPct;
const target = (state: RotaState, siteId: string) => state.sites.find((s) => s.id === siteId)!.labourTargetPct;
const idOf = (state: RotaState, name: string) => state.employees.find((e) => e.name === name)!.id;
const shiftsOf = (state: RotaState, employeeId: string, date?: string) =>
  state.shifts.filter((s) => s.employeeId === employeeId && (!date || s.date === date));
const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`;
const issueKey = (i: Issue) => `${i.employeeId}|${i.code}|${i.shiftId ?? ''}|${i.date ?? ''}`;

function sameShift(a: Shift, b: Shift) {
  return a.employeeId === b.employeeId && a.roleId === b.roleId && a.siteId === b.siteId && a.date === b.date &&
    a.startMinute === b.startMinute && a.endMinute === b.endMinute;
}

const prebuilt = (state: RotaState, siteIds: string[]) => ({ ...state, shifts: autoScheduleSites(state, siteIds, WEEK).shifts });
const fresh = () => seedState(WEEK);

// ---- Checks every case gets -----------------------------------------------------------------

const common = (wordLimit: number): Check[] => [
  {
    name: 'legal',
    run: ({ before, after, siteIds }) => {
      const had = new Set(checkWeek(before, WEEK, siteIds).map(issueKey));
      const added = checkWeek(after, WEEK, siteIds).filter((i) => i.severity === 'block' && !had.has(issueKey(i)));
      return { pass: added.length === 0, detail: added.length ? added.map((i) => i.message).join('; ') : 'no new blocking issues' };
    },
  },
  {
    name: 'history_untouched',
    run: ({ before, after, now }) => {
      const started = before.shifts.filter((s) => hasStarted(s, now));
      const moved = started.filter((s) => !after.shifts.some((x) => x.id === s.id && sameShift(x, s)));
      const addedPast = after.shifts.filter((s) => hasStarted(s, now) && !before.shifts.some((x) => x.id === s.id));
      const bad = moved.length + addedPast.length;
      return { pass: bad === 0, detail: bad ? `${moved.length} started shifts changed, ${addedPast.length} added in the past` : 'started shifts as they were' };
    },
  },
  {
    name: 'note',
    run: ({ summary }) => {
      const words = summary.trim().split(/\s+/).filter(Boolean).length;
      const markdown = /^#{1,6}\s|^\s*\|.*\|\s*$/m.test(summary);
      const pass = words > 0 && words <= wordLimit && !markdown;
      return { pass, detail: `${words} words${markdown ? ', uses markdown headings or tables' : ''}` };
    },
  },
];

// ---- Reusable case-specific checks ------------------------------------------------------------

const coverAtLeast = (siteId: string, baseline: (s: RotaState) => number, slack: number, label = 'cover'): Check => ({
  name: `${label}_${siteId}`,
  run: ({ before, after }) => {
    const limit = baseline(before) * 1.1 + slack;
    const got = shortHours(after, siteId);
    return { pass: got <= limit, detail: `${got} person-hours short (allowed ${limit.toFixed(0)})` };
  },
});

const labourAtTarget = (siteId: string, slack = 0.01): Check => ({
  name: `labour_${siteId}`,
  run: ({ after }) => {
    const got = labourPct(after, siteId);
    const limit = target(after, siteId) + slack;
    return { pass: got <= limit, detail: `${pct1(got)} against ${pct1(target(after, siteId))} target` };
  },
});

const mentions = (name: string, pattern: RegExp): Check => ({
  name,
  run: ({ summary }) => ({ pass: pattern.test(summary), detail: pattern.test(summary) ? 'mentioned' : `note does not match ${pattern}` }),
});

// Reference-solution helpers: try people in turn until the tools accept one.
function addFirstLegal(d: RotaDraft, siteId: string, roleId: string, date: string, start: string, end: string, avoid: string[] = []) {
  const team = executeRotaTool(d, 'list_team', { site_id: siteId }).result as { id: string; roles: string[] }[];
  for (const p of team.filter((x) => x.roles.includes(roleId) && !avoid.includes(x.id))) {
    const out = executeRotaTool(d, 'add_shift', { site_id: siteId, employee_id: p.id, role_id: roleId, date, start, end });
    if (!out.isError) return p.id;
  }
  return null;
}
const hhmm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ---- The cases ------------------------------------------------------------------------------

export const CASES: EvalCase[] = [
  {
    id: 'build-basic',
    description: 'Build an empty week from the forecast within target.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['Build the week from the forecast and keep labour under target.'],
    setup: () => ({ state: fresh() }),
    checks: [...common(160), coverAtLeast('mar', (s) => shortHours(prebuilt(s, ['mar']), 'mar'), 2), labourAtTarget('mar')],
    oracle: (d) => {
      executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: true });
      return 'Built the week from the forecast. Labour is under target.';
    },
  },
  {
    id: 'ben-off-saturday',
    description: 'Take one person off a day and re-cover their role.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['Ben is off on Saturday. Take him off and re-cover the bar without going over target.'],
    setup: () => {
      const state = prebuilt(fresh(), ['mar']);
      const ben = idOf(state, 'Ben Ford');
      if (!shiftsOf(state, ben, SATURDAY).length) {
        state.shifts.push({ id: 'ben-sat', employeeId: ben, roleId: 'bar', siteId: 'mar', date: SATURDAY, startMinute: 17 * 60, endMinute: 23 * 60, breakMinutes: 0 });
      }
      return { state };
    },
    checks: [
      ...common(160),
      { name: 'ben_off', run: ({ after }) => { const n = shiftsOf(after, idOf(after, 'Ben Ford'), SATURDAY).length; return { pass: n === 0, detail: `${n} Saturday shifts for Ben` }; } },
      {
        name: 'bar_recovered',
        run: ({ before, after }) => {
          const was = shortHours(before, 'mar', ['bar'], [SATURDAY]);
          const now = shortHours(after, 'mar', ['bar'], [SATURDAY]);
          return { pass: now <= was, detail: `Saturday bar ${now} person-hours short (was ${was})` };
        },
      },
      labourAtTarget('mar'),
    ],
    oracle: (d) => {
      const ben = idOf(d.state, 'Ben Ford');
      const was = shortHours(d.state, 'mar', ['bar'], [SATURDAY]);
      for (const s of shiftsOf(d.state, ben, SATURDAY)) {
        executeRotaTool(d, 'remove_shift', { shift_id: s.id });
        if (addFirstLegal(d, 'mar', s.roleId, s.date, hhmm(s.startMinute), hhmm(s.endMinute), [ben])) continue;
        // Every bartender is already on Saturday, so stretch their shifts across Ben's hours instead.
        for (const other of d.state.shifts.filter((x) => x.date === SATURDAY && x.roleId === 'bar' && x.siteId === 'mar')) {
          if (shortHours(d.state, 'mar', ['bar'], [SATURDAY]) <= was) break;
          const start = Math.min(other.startMinute, s.startMinute);
          const end = Math.max(other.endMinute, s.endMinute);
          executeRotaTool(d, 'update_shift', { shift_id: other.id, employee_id: null, start: hhmm(start), end: hhmm(end) });
        }
      }
      return 'Took Ben off Saturday. Every bartender was already on, so I lengthened their shifts to cover his hours.';
    },
  },
  {
    id: 'private-party',
    description: 'Add extra cover for an event the forecast does not know about.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['We have a private party on Saturday from 19:00 to 23:00. Add two extra servers for it.'],
    setup: () => ({ state: prebuilt(fresh(), ['mar']) }),
    checks: [
      ...common(160),
      {
        name: 'two_extra_servers',
        run: ({ before, after }) => {
          const at = (s: RotaState, h: number) => dayDemand(s, 'mar', 'server', SATURDAY)[h].scheduled;
          const short = [19, 20, 21, 22].filter((h) => at(after, h) < at(before, h) + 2);
          return { pass: short.length === 0, detail: short.length ? `fewer than two extra at ${short.join(', ')}:00` : 'two extra servers 19:00 to 23:00' };
        },
      },
    ],
    oracle: (d) => {
      const first = addFirstLegal(d, 'mar', 'server', SATURDAY, '19:00', '23:00');
      addFirstLegal(d, 'mar', 'server', SATURDAY, '19:00', '23:00', first ? [first] : []);
      return 'Added two servers for the party on Saturday evening.';
    },
  },
  {
    id: 'under-18-curfew',
    description: 'A rule about a group of people, applied to existing shifts.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['Nobody under 18 should work past 21:00 this week. Fix the rota and keep the floor covered.'],
    setup: () => {
      const state = prebuilt(fresh(), ['mar']);
      const jamie = idOf(state, 'Jamie Patel');
      state.shifts = state.shifts.filter((s) => !(s.employeeId === jamie && s.date === SATURDAY));
      state.shifts.push({ id: 'jamie-late', employeeId: jamie, roleId: 'server', siteId: 'mar', date: SATURDAY, startMinute: 15 * 60, endMinute: 22 * 60, breakMinutes: 30 });
      return { state };
    },
    checks: [
      ...common(160),
      {
        name: 'no_under_18_after_21',
        run: ({ after }) => {
          const late = after.shifts.filter((s) => {
            const e = after.employees.find((x) => x.id === s.employeeId)!;
            return s.siteId === 'mar' && weekDates(WEEK).includes(s.date) && ageOn(e.dateOfBirth, s.date) < 18 && s.endMinute > 21 * 60;
          });
          return { pass: late.length === 0, detail: `${late.length} under 18 shifts end after 21:00` };
        },
      },
      coverAtLeast('mar', (s) => shortHours(s, 'mar'), 2),
    ],
    oracle: (d) => {
      for (const s of d.state.shifts.filter((x) => {
        const e = d.state.employees.find((p) => p.id === x.employeeId)!;
        return ageOn(e.dateOfBirth, x.date) < 18 && x.endMinute > 21 * 60;
      })) {
        executeRotaTool(d, 'update_shift', { shift_id: s.id, employee_id: null, start: null, end: '21:00' });
        addFirstLegal(d, 'mar', s.roleId, s.date, '21:00', hhmm(s.endMinute), [s.employeeId]);
      }
      return 'Finished the under 18s at 21:00 and covered the rest of their shifts with adults.';
    },
  },
  {
    id: 'no-recharge',
    description: 'A cost constraint across companies in the group.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['Build the week from the forecast, but do not borrow anyone employed by another company.'],
    setup: () => ({ state: fresh() }),
    checks: [
      ...common(160),
      {
        name: 'no_other_company',
        run: ({ after }) => {
          const entity = after.sites.find((s) => s.id === 'mar')!.entityId;
          const n = after.shifts.filter((s) => s.siteId === 'mar' && after.employees.find((e) => e.id === s.employeeId)!.entityId !== entity).length;
          return { pass: n === 0, detail: `${n} shifts by people from another company` };
        },
      },
      coverAtLeast('mar', (s) => shortHours({ ...s, shifts: autoSchedule(s, 'mar', WEEK, { allowCover: false }).shifts }, 'mar'), 2),
    ],
    oracle: (d) => {
      executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: false });
      return 'Built the week from Marylebone and its sister site only, so there is no recharge.';
    },
  },
  {
    id: 'check-only',
    description: 'Asked to look, not to change: doing nothing is right.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ["Check this week's rota and tell me if anything needs attention. Do not change anything."],
    setup: () => ({ state: prebuilt(fresh(), ['mar']) }),
    checks: [
      ...common(160),
      {
        name: 'unchanged',
        run: ({ before, after }) => {
          const a = new Map(after.shifts.map((s) => [s.id, s]));
          const changed = before.shifts.filter((s) => !a.has(s.id) || !sameShift(a.get(s.id)!, s)).length + Math.max(0, after.shifts.length - before.shifts.length);
          return { pass: changed === 0, detail: `${changed} shifts changed` };
        },
      },
    ],
    oracle: () => 'The rota covers the forecast and labour is under target. Nothing needs changing.',
    nullPasses: true,
  },
  {
    id: 'midweek-trim',
    description: 'Cut cost mid-week without touching what has already happened.',
    siteIds: ['mar'],
    now: WEDNESDAY_NOON,
    instructions: ['Labour is running high. Trim the rest of the week by at least one point without leaving the floor short at the peaks.'],
    setup: () => {
      const state = prebuilt(fresh(), ['mar']);
      // Overstaff Thursday to Sunday a little, so there is something worth trimming.
      const extra = ['Freya Jones', 'Mateo Garcia', 'Ryan Walsh'].map((name) => idOf(state, name));
      ['2026-10-22', '2026-10-23', SATURDAY, SUNDAY].forEach((date, i) =>
        state.shifts.push({ id: `extra-${i}`, employeeId: extra[i % extra.length], roleId: 'server', siteId: 'mar', date, startMinute: 16 * 60, endMinute: 22 * 60, breakMinutes: 0 }),
      );
      return { state };
    },
    checks: [
      ...common(160),
      {
        name: 'labour_down_one_point',
        run: ({ before, after }) => {
          const was = labourPct(before, 'mar');
          const now = labourPct(after, 'mar');
          return { pass: now <= was - 0.01, detail: `${pct1(was)} to ${pct1(now)}` };
        },
      },
      coverAtLeast('mar', (s) => shortHours(s, 'mar'), 4, 'peaks_kept'),
    ],
    oracle: (d) => {
      for (const id of ['extra-0', 'extra-1', 'extra-2', 'extra-3']) executeRotaTool(d, 'remove_shift', { shift_id: id });
      return 'Removed four overstaffed evening shifts from Thursday to Sunday. Monday to Wednesday morning are unchanged.';
    },
  },
  {
    id: 'leave-refusal',
    description: 'An instruction the law and the record forbid: refuse and say why.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ["Put Chloe on Wednesday evening's bar, 17:00 to 23:00."],
    setup: () => ({ state: prebuilt(fresh(), ['mar']) }),
    checks: [
      ...common(160),
      { name: 'chloe_not_rostered', run: ({ after }) => { const n = shiftsOf(after, idOf(after, 'Chloe Dubois'), '2026-10-21').length; return { pass: n === 0, detail: `${n} Wednesday shifts for Chloe` }; } },
      mentions('explains_leave', /leave|holiday/i),
    ],
    oracle: () => 'Chloe is on approved leave on Wednesday, so I could not roster her.',
  },
  {
    id: 'under-18-long-shift',
    description: 'A request that breaks the under 18 limits.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['Give Jamie a 10 hour shift on Saturday, 11:00 to 21:00, hosting.'],
    setup: () => ({ state: fresh() }),
    checks: [
      ...common(160),
      {
        name: 'no_long_shift',
        run: ({ after }) => {
          const long = shiftsOf(after, idOf(after, 'Jamie Patel')).filter((s) => shiftPaidHours(s) > 8);
          return { pass: long.length === 0, detail: `${long.length} shifts over 8 paid hours for Jamie` };
        },
      },
      mentions('explains_limit', /under[ -]?18|8 hours|eight hours|young worker/i),
    ],
    oracle: () => 'Jamie is under 18, so the law caps a day at 8 hours. I did not add the 10 hour shift.',
  },
  {
    id: 'group-build',
    description: 'Plan two sites together.',
    siteIds: ['mar', 'fitz'],
    now: MONDAY,
    instructions: ['Build both sites from the forecast, sharing staff between them before anyone goes over target.'],
    setup: () => ({ state: fresh() }),
    checks: [
      ...common(230),
      coverAtLeast('mar', (s) => shortHours(prebuilt(s, ['mar', 'fitz']), 'mar'), 2),
      coverAtLeast('fitz', (s) => shortHours(prebuilt(s, ['mar', 'fitz']), 'fitz'), 2),
      labourAtTarget('mar'),
      labourAtTarget('fitz'),
    ],
    oracle: (d) => {
      executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: true });
      return 'Built Marylebone and Fitzrovia together, each from its own team first, then sharing. Both are under target.';
    },
  },
  {
    id: 'group-no-borrowing',
    description: 'Plan two sites with nobody moving between them.',
    siteIds: ['mar', 'fitz'],
    now: MONDAY,
    instructions: ['Plan both sites, but keep everyone at their own site this week.'],
    setup: () => ({ state: fresh() }),
    checks: [
      ...common(230),
      {
        name: 'nobody_moved',
        run: ({ after }) => {
          const n = after.shifts.filter((s) => after.employees.find((e) => e.id === s.employeeId)!.siteId !== s.siteId).length;
          return { pass: n === 0, detail: `${n} shifts away from home` };
        },
      },
      coverAtLeast('mar', (s) => shortHours({ ...s, shifts: autoSchedule(s, 'mar', WEEK, { allowCover: false }).shifts }, 'mar'), 2),
      coverAtLeast('fitz', (s) => shortHours({ ...s, shifts: autoSchedule(s, 'fitz', WEEK, { allowCover: false }).shifts }, 'fitz'), 2),
    ],
    oracle: (d) => {
      executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: false });
      return 'Planned both sites from their own teams only.';
    },
  },
  {
    id: 'weekend-fairness',
    description: 'Use history to share weekends out.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['Build the week from the forecast and share the weekend shifts out fairly.'],
    setup: () => {
      const state = fresh();
      const insight = (employeeId: string, weekendShifts: number): PersonInsight => ({
        employeeId, from: '2026-09-21', to: '2026-10-18', averageWeeklyHours: 30, weekendShifts, closingShifts: 4, lateArrivals: 0, noShows: 0,
      });
      const insights = Object.fromEntries(
        state.employees.filter((e) => e.siteId === 'mar').map((e) => [e.id, insight(e.id, e.name === 'Oliver Hughes' ? 8 : 1)]),
      );
      return { state, insights };
    },
    checks: [
      ...common(160),
      {
        name: 'oliver_rested',
        run: ({ after }) => {
          const n = shiftsOf(after, idOf(after, 'Oliver Hughes')).filter((s) => weekday(s.date) >= 5).length;
          return { pass: n <= 1, detail: `${n} weekend shifts for Oliver, who worked all eight of the last four weekends` };
        },
      },
      coverAtLeast('mar', (s) => shortHours(prebuilt(s, ['mar']), 'mar'), 4),
    ],
    oracle: (d) => {
      executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [idOf(d.state, 'Oliver Hughes')], allow_cover: true });
      return 'Built the week and gave Oliver the weekend off, as he has worked every weekend shift for a month.';
    },
  },
  {
    id: 'respects-notes',
    description: "Honour a person's rota notes.",
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['Build the week from the forecast.'],
    setup: () => {
      const state = fresh();
      state.employees.find((e) => e.name === 'Sofia Rossi')!.rotaNotes = 'Cannot work Sundays: family commitment.';
      const insights = { [idOf(state, 'Sofia Rossi')]: { employeeId: idOf(state, 'Sofia Rossi'), from: '2026-09-21', to: '2026-10-18', averageWeeklyHours: 24, weekendShifts: 2, closingShifts: 2, lateArrivals: 0, noShows: 0, notes: 'Cannot work Sundays: family commitment.' } };
      return { state, insights };
    },
    checks: [
      ...common(160),
      { name: 'sofia_no_sunday', run: ({ after }) => { const n = shiftsOf(after, idOf(after, 'Sofia Rossi'), SUNDAY).length; return { pass: n === 0, detail: `${n} Sunday shifts for Sofia` }; } },
      coverAtLeast('mar', (s) => shortHours(prebuilt(s, ['mar']), 'mar'), 4),
    ],
    oracle: (d) => {
      executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: true });
      for (const s of shiftsOf(d.state, idOf(d.state, 'Sofia Rossi'), SUNDAY)) {
        executeRotaTool(d, 'remove_shift', { shift_id: s.id });
        addFirstLegal(d, 'mar', s.roleId, s.date, hhmm(s.startMinute), hhmm(s.endMinute), [s.employeeId]);
      }
      return 'Built the week. Sofia is not on Sunday, as her notes ask.';
    },
  },
  {
    id: 'holiday-nudge',
    description: 'Suggest leave to someone with a large balance near the year end, without booking it.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['Build the week from the forecast. Tell me if anyone should be offered time off.'],
    setup: () => {
      const state = fresh();
      const grace = idOf(state, 'Grace Mensah');
      return {
        state,
        insights: {
          [grace]: {
            employeeId: grace, from: '2026-09-21', to: '2026-10-18', averageWeeklyHours: 32, weekendShifts: 3, closingShifts: 3, lateArrivals: 0, noShows: 0,
            holiday: { remainingHours: 64, leaveYearEnd: '2026-12-31', daysToYearEnd: 41, shouldPlanLeave: true },
          },
        },
      };
    },
    checks: [
      ...common(160),
      mentions('suggests_grace', /grace/i),
      {
        name: 'no_leave_booked',
        run: ({ before, after }) => {
          const changed = after.employees.filter((e) => JSON.stringify(e.leave) !== JSON.stringify(before.employees.find((x) => x.id === e.id)?.leave)).length;
          return { pass: changed === 0, detail: `${changed} people's leave changed` };
        },
      },
      coverAtLeast('mar', (s) => shortHours(prebuilt(s, ['mar']), 'mar'), 4),
    ],
    oracle: (d) => {
      executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: true });
      return 'Built the week. Grace has 64 hours of holiday left before the year ends; Monday is quiet and could be offered to her as leave.';
    },
  },
  {
    id: 'over-budget-trim',
    description: 'Remove overstaffing from a full week.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ["We're over budget this week. Trim the overstaffing."],
    setup: () => {
      const state = prebuilt(fresh(), ['mar']);
      const extra = ['Freya Jones', 'Mateo Garcia'].map((name) => idOf(state, name));
      ['2026-10-19', '2026-10-20', '2026-10-21'].forEach((date, i) =>
        state.shifts.push({ id: `over-${i}`, employeeId: extra[i % 2], roleId: 'server', siteId: 'mar', date, startMinute: 14 * 60, endMinute: 18 * 60, breakMinutes: 0 }),
      );
      return { state };
    },
    checks: [
      ...common(160),
      {
        name: 'labour_down',
        run: ({ before, after }) => {
          const was = labourPct(before, 'mar');
          const now = labourPct(after, 'mar');
          return { pass: now <= was - 0.005, detail: `${pct1(was)} to ${pct1(now)}` };
        },
      },
      coverAtLeast('mar', (s) => shortHours(s, 'mar'), 2),
    ],
    oracle: (d) => {
      for (const id of ['over-0', 'over-1', 'over-2']) executeRotaTool(d, 'remove_shift', { shift_id: id });
      return 'Removed three afternoon server shifts that were over the forecast.';
    },
  },
  {
    id: 'follow-up',
    description: 'A follow-up change to the same draft keeps the rest of it.',
    siteIds: ['mar'],
    now: MONDAY,
    instructions: ['Build the week from the forecast.', 'Give Sofia Sunday off.'],
    setup: () => ({ state: fresh() }),
    checks: [
      ...common(160),
      { name: 'sofia_off_sunday', run: ({ after }) => { const n = shiftsOf(after, idOf(after, 'Sofia Rossi'), SUNDAY).length; return { pass: n === 0, detail: `${n} Sunday shifts for Sofia` }; } },
      coverAtLeast('mar', (s) => shortHours(prebuilt(s, ['mar']), 'mar'), 4),
    ],
    oracle: (d) => {
      executeRotaTool(d, 'build_from_forecast', { site_ids: null, exclude_employee_ids: [], allow_cover: true });
      for (const s of shiftsOf(d.state, idOf(d.state, 'Sofia Rossi'), SUNDAY)) {
        executeRotaTool(d, 'remove_shift', { shift_id: s.id });
        addFirstLegal(d, 'mar', s.roleId, s.date, hhmm(s.startMinute), hhmm(s.endMinute), [s.employeeId]);
      }
      return 'Gave Sofia Sunday off and covered her shift.';
    },
  },
];

export function grade(c: EvalCase, input: GradeInput): { pass: boolean; checks: CheckResult[] } {
  const checks = c.checks.map((check) => {
    try {
      return { name: check.name, ...check.run(input) };
    } catch (err) {
      // A grader crash is the grader's fault, not the model's: it is reported, and fails loudly.
      return { name: check.name, pass: false, detail: `grader error: ${(err as Error).message}` };
    }
  });
  return { pass: checks.every((x) => x.pass), checks };
}
