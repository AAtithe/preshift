// Account set-up: turning what an operator tells us about their business into a RotaState.
// Pure functions so the rules are tested here, not discovered in the UI.

import { minimumWageFor } from './ukRates';
import { addDays, ageOn, parseISODate, toISODate, weekDates, weekStart } from './time';
import type { DemandRule, Department, Employee, HourForecast, RotaState, Role, Site } from './types';

export interface SetupDraft {
  sites: Site[];
  roles: Role[];
  employees: Employee[];
  demandRules: DemandRule[];
}

export const DEPARTMENTS: { id: Department; label: string; nominalCode: string }[] = [
  { id: 'FOH', label: 'Front of house', nominalCode: '7000' },
  { id: 'BOH', label: 'Kitchen', nominalCode: '7001' },
  { id: 'BAR', label: 'Bar', nominalCode: '7002' },
  { id: 'MGMT', label: 'Management', nominalCode: '7003' },
];

type RuleDefaults = Pick<DemandRule, 'salesPerLabourHour' | 'coversPerHour' | 'minimumWhileOpen' | 'maximum'>;

/** Standard roles with the staffing ratios we see across our restaurant clients. */
export const ROLE_TEMPLATE: (Role & { rule: RuleDefaults | null })[] = [
  { id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000', rule: { coversPerHour: 14, minimumWhileOpen: 1, maximum: 6 } },
  { id: 'host', name: 'Host', department: 'FOH', nominalCode: '7000', rule: { coversPerHour: 60, minimumWhileOpen: 0, maximum: 1 } },
  { id: 'bar', name: 'Bartender', department: 'BAR', nominalCode: '7002', rule: { salesPerLabourHour: 380, minimumWhileOpen: 1, maximum: 3 } },
  { id: 'chef', name: 'Chef', department: 'BOH', nominalCode: '7001', rule: { coversPerHour: 22, minimumWhileOpen: 1, maximum: 4 } },
  { id: 'kp', name: 'Kitchen Porter', department: 'BOH', nominalCode: '7001', rule: { coversPerHour: 45, minimumWhileOpen: 1, maximum: 2 } },
  { id: 'gm', name: 'General Manager', department: 'MGMT', nominalCode: '7003', rule: null },
];

const DEPARTMENT_RULE: Record<Department, RuleDefaults | null> = {
  FOH: { coversPerHour: 14, minimumWhileOpen: 1, maximum: 6 },
  BAR: { salesPerLabourHour: 380, minimumWhileOpen: 1, maximum: 3 },
  BOH: { coversPerHour: 22, minimumWhileOpen: 1, maximum: 4 },
  // Managers are rostered by hand, not driven by covers.
  MGMT: null,
};

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultRule(role: Role, siteId: string): DemandRule | null {
  const template = ROLE_TEMPLATE.find((t) => t.id === role.id && t.department === role.department);
  const rule = template ? template.rule : DEPARTMENT_RULE[role.department];
  return rule ? { ...rule, roleId: role.id, siteId } : null;
}

export function newSite(name = ''): Site {
  return {
    id: uid('site'),
    name,
    labourTargetPct: 0.28,
    trackingCode: name,
    openMinute: 12 * 60,
    closeMinute: 23 * 60,
    // Blank on purpose: a forecast built on our numbers instead of theirs would look right and be wrong.
    salesProfile: { dailySales: [0, 0, 0, 0, 0, 0, 0], averageSpend: 0 },
  };
}

export function newEmployee(siteId: string, roleId: string): Employee {
  return {
    id: uid('emp'),
    name: '',
    siteId,
    roleIds: roleId ? [roleId] : [],
    payBasis: 'hourly',
    hourlyRate: 12.71,
    annualSalary: 0,
    dateOfBirth: '',
    contractedHours: 0,
    maxWeeklyHours: 48,
    optedOutOf48: false,
    irregularHours: true,
    pensionEnrolled: true,
    availability: [],
    leave: [],
  };
}

export function emptyDraft(): SetupDraft {
  const site = newSite();
  const roles = ROLE_TEMPLATE.map(({ rule: _rule, ...role }) => role);
  return {
    sites: [site],
    roles,
    employees: [],
    demandRules: roles.flatMap((r) => defaultRule(r, site.id) ?? []),
  };
}

export function draftFromState(state: RotaState): SetupDraft {
  return {
    sites: state.sites.map((s) => ({ ...s, salesProfile: s.salesProfile ?? profileFromForecast(state, s) })),
    roles: state.roles,
    employees: state.employees,
    demandRules: state.demandRules,
  };
}

/** Best guess at a typical week for a site set up before profiles existed: its latest forecast week. */
function profileFromForecast(state: RotaState, site: Site) {
  const rows = state.forecast.filter((f) => f.siteId === site.id);
  const dailySales = [0, 0, 0, 0, 0, 0, 0];
  if (rows.length === 0) return { dailySales, averageSpend: 40 };
  const latest = weekStart(rows.reduce((max, f) => (f.date > max ? f.date : max), rows[0].date));
  const week = weekDates(latest);
  let sales = 0;
  let covers = 0;
  for (const f of rows) {
    const day = week.indexOf(f.date);
    if (day < 0) continue;
    dailySales[day] += f.sales;
    sales += f.sales;
    covers += f.covers;
  }
  return { dailySales, averageSpend: covers ? Math.round(sales / covers) : 40 };
}

// Share of a typical day's takings by clock hour: breakfast, lunch peak, quiet afternoon, dinner peak.
const HOUR_WEIGHT = [
  0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.03, 0.04, 0.03, 0.02, 0.02,
  0.09, 0.11, 0.06, 0.03, 0.03, 0.06, 0.11, 0.15, 0.15, 0.1, 0.06, 0.03,
];

export function forecastForWeek(site: Site, start: string): HourForecast[] {
  const profile = site.salesProfile;
  if (!profile) return [];
  const open = HOUR_WEIGHT.map((_, h) => h).filter((h) => h * 60 >= site.openMinute && h * 60 < site.closeMinute);
  const total = open.reduce((sum, h) => sum + HOUR_WEIGHT[h], 0);
  if (!total) return [];
  return weekDates(start).flatMap((date, day) => {
    const daySales = profile.dailySales[day] ?? 0;
    if (daySales <= 0) return [];
    // Round each hour but put the pennies on the last one so the day ties back to the profile.
    let allocated = 0;
    return open.map((hour, i) => {
      const sales = i === open.length - 1 ? daySales - allocated : Math.round((daySales * HOUR_WEIGHT[hour]) / total);
      allocated += sales;
      const covers = profile.averageSpend > 0 ? Math.round(sales / profile.averageSpend) : 0;
      return { siteId: site.id, date, hour, sales, covers };
    });
  });
}

/** Forecast rows for sites that have a profile but nothing forecast in this week. */
export function missingForecast(state: RotaState, start: string): HourForecast[] {
  const dates = new Set(weekDates(start));
  return state.sites.flatMap((site) =>
    state.forecast.some((f) => f.siteId === site.id && dates.has(f.date)) ? [] : forecastForWeek(site, start),
  );
}

export interface SetupIssue {
  severity: 'error' | 'warning';
  message: string;
}

export function validateSetup(draft: SetupDraft, today = toISODate(new Date())): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const error = (message: string) => issues.push({ severity: 'error', message });
  const warning = (message: string) => issues.push({ severity: 'warning', message });

  if (draft.sites.length === 0) error('Add at least one site.');
  for (const site of draft.sites) {
    const label = site.name.trim() || 'A site';
    if (!site.name.trim()) error('Every site needs a name.');
    if (site.closeMinute <= site.openMinute) error(`${label}: closing time must be after opening time, up to midnight.`);
    if (!(site.labourTargetPct > 0 && site.labourTargetPct < 1)) error(`${label}: labour target must be between 0% and 100%.`);
    const profile = site.salesProfile;
    if (!profile || profile.dailySales.every((d) => !(d > 0))) error(`${label}: enter typical net sales for at least one day.`);
    if (profile && !(profile.averageSpend > 0)) error(`${label}: enter an average spend per cover.`);
    if (!draft.employees.some((e) => e.siteId === site.id)) warning(`${label} has no team yet, so nothing can be rostered there.`);
  }

  if (draft.roles.length === 0) error('Add at least one role.');
  const names = new Set<string>();
  for (const role of draft.roles) {
    if (!role.name.trim()) error('Every role needs a name.');
    if (names.has(role.name.trim().toLowerCase())) error(`Two roles are called ${role.name}.`);
    names.add(role.name.trim().toLowerCase());
    if (!role.nominalCode.trim()) error(`${role.name || 'A role'}: add the nominal code its wages post to.`);
  }

  for (const e of draft.employees) {
    const label = e.name.trim() || 'A team member';
    if (!e.name.trim()) error('Every team member needs a name.');
    if (e.roleIds.length === 0) error(`${label}: pick at least one role.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.dateOfBirth) || Number.isNaN(parseISODate(e.dateOfBirth).getTime())) {
      error(`${label}: date of birth is needed to check minimum wage and young worker rules.`);
      continue;
    }
    const age = ageOn(e.dateOfBirth, today);
    if (age < 13 || age > 100) error(`${label}: date of birth gives an age of ${age}. Check it.`);
    if (e.payBasis === 'hourly') {
      const band = minimumWageFor(age);
      if (!(e.hourlyRate > 0)) error(`${label}: enter an hourly rate.`);
      else if (band && e.hourlyRate < band.hourly) {
        warning(`${label}: £${e.hourlyRate.toFixed(2)} is below the ${band.label} of £${band.hourly.toFixed(2)}. Only correct for an apprentice.`);
      }
    } else if (!(e.annualSalary > 0)) error(`${label}: enter an annual salary.`);
    if (e.contractedHours > e.maxWeeklyHours) error(`${label}: contracted hours are above their weekly maximum.`);
    if (e.maxWeeklyHours > 48 && !e.optedOutOf48) warning(`${label}: a weekly maximum over 48 hours needs a signed opt-out.`);
  }

  for (const rule of draft.demandRules) {
    if (rule.maximum < rule.minimumWhileOpen) {
      const role = draft.roles.find((r) => r.id === rule.roleId)?.name ?? 'A role';
      const site = draft.sites.find((s) => s.id === rule.siteId)?.name ?? 'a site';
      error(`${role} at ${site}: maximum headcount is below the minimum.`);
    }
  }
  return issues;
}

/** What applying the draft does to rostered shifts that no longer fit. */
export function droppedShifts(prev: RotaState | null, draft: SetupDraft): number {
  if (!prev) return 0;
  return prev.shifts.length - keptShifts(prev, draft).length;
}

function keptShifts(prev: RotaState, draft: SetupDraft) {
  const sites = new Set(draft.sites.map((s) => s.id));
  const roles = new Set(draft.roles.map((r) => r.id));
  const people = new Map(draft.employees.map((e) => [e.id, e]));
  return prev.shifts.filter((s) => {
    const e = people.get(s.employeeId);
    return e && e.siteId === s.siteId && sites.has(s.siteId) && roles.has(s.roleId) && e.roleIds.includes(s.roleId);
  });
}

/**
 * Builds the account's state from the draft. Past forecast is kept as the record; this week onward
 * is regenerated from the profiles so changed trading patterns take effect immediately.
 */
export function applySetup(prev: RotaState | null, draft: SetupDraft, today = toISODate(new Date())): RotaState {
  const start = weekStart(today);
  const sites = draft.sites.map((s) => ({ ...s, name: s.name.trim(), trackingCode: s.trackingCode.trim() || s.name.trim() }));
  const siteIds = new Set(sites.map((s) => s.id));
  const roleIds = new Set(draft.roles.map((r) => r.id));
  const history = (prev?.forecast ?? []).filter((f) => f.date < start && siteIds.has(f.siteId));
  const ahead = sites.flatMap((site) => [0, 1, 2, 3].flatMap((w) => forecastForWeek(site, addDays(start, w * 7))));
  return {
    sites,
    roles: draft.roles.map((r) => ({ ...r, name: r.name.trim(), nominalCode: r.nominalCode.trim() })),
    employees: draft.employees
      .filter((e) => siteIds.has(e.siteId))
      .map((e) => ({ ...e, name: e.name.trim(), roleIds: e.roleIds.filter((r) => roleIds.has(r)), irregularHours: e.contractedHours === 0 })),
    shifts: prev ? keptShifts(prev, draft) : [],
    forecast: [...history, ...ahead],
    demandRules: draft.demandRules.filter((r) => siteIds.has(r.siteId) && roleIds.has(r.roleId)),
  };
}

export interface PasteResult {
  employees: Employee[];
  errors: string[];
}

/**
 * Reads a team list pasted from a spreadsheet or payroll export, one person per line:
 *   Name, Roles, Rate or salary, Date of birth, Contracted hours
 * Roles are separated by "/" and matched to role names. Tabs or commas both work.
 */
export function parseTeamPaste(text: string, siteId: string, roles: Role[]): PasteResult {
  const employees: Employee[] = [];
  const errors: string[] = [];
  const byName = new Map(roles.map((r) => [r.name.trim().toLowerCase(), r.id]));
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const cells = line.split(line.includes('\t') ? '\t' : ',').map((c) => c.trim());
    const [name, roleCell = '', payCell = '', dobCell = '', hoursCell = ''] = cells;
    if (i === 0 && /^name$/i.test(name)) return; // header row
    const row = `Line ${i + 1}`;
    if (!name) return void errors.push(`${row}: no name.`);
    const roleIds: string[] = [];
    for (const r of roleCell.split('/').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      const id = byName.get(r);
      if (id) roleIds.push(id);
      else errors.push(`${row} (${name}): no role called "${r}".`);
    }
    const pay = Number(payCell.replace(/[£,\s]/g, ''));
    const dob = parseDate(dobCell);
    if (!dob) errors.push(`${row} (${name}): date of birth "${dobCell}" not recognised. Use DD/MM/YYYY.`);
    const contracted = Number(hoursCell) || 0;
    const e = newEmployee(siteId, '');
    // Anything over £1,000 is an annual salary, not an hourly rate.
    const salaried = pay > 1000;
    employees.push({
      ...e,
      name,
      roleIds,
      payBasis: salaried ? 'salaried' : 'hourly',
      hourlyRate: salaried ? 0 : pay || 0,
      annualSalary: salaried ? pay : 0,
      dateOfBirth: dob ?? '',
      contractedHours: contracted,
      irregularHours: contracted === 0,
    });
  });
  return { employees, errors };
}

function parseDate(value: string): string | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? (Number(m[3]) > 30 ? 1900 : 2000) + Number(m[3]) : Number(m[3]);
  const iso = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = parseISODate(iso);
  return d.getUTCDate() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) ? iso : null;
}
