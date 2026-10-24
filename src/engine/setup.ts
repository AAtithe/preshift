// Business set-up: the companies, sites, roles and staffing rules the rota runs on, and the
// forecast worked from each site's typical week. Shared by the API, which enforces it, and the
// set-up screen, which explains it. People are not part of it: they go through the employee
// routes so every starter reaches payroll.

import { minimumWageFor } from './ukRates';
import { calendarHour, isOpenHour, LATEST_CLOSE, tradingDayHours } from './demand';
import { addDays, ageOn, parseISODate, weekDates, weekStart } from './time';
import type { DemandRule, Department, Employee, Entity, HourForecast, RotaState, Role, Site } from './types';

export interface SetupDraft {
  entities: Entity[];
  sites: Site[];
  roles: Role[];
  demandRules: DemandRule[];
}

export interface SetupIssue {
  severity: 'block' | 'warn';
  message: string;
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

export const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export function defaultRule(role: Role, siteId: string): DemandRule | null {
  const template = ROLE_TEMPLATE.find((t) => t.id === role.id && t.department === role.department);
  const rule = template ? template.rule : DEPARTMENT_RULE[role.department];
  return rule ? { ...rule, roleId: role.id, siteId } : null;
}

export function newEntity(name = ''): Entity {
  return { id: uid('co'), name, companyNumber: '', payeReference: '', intercompanyCode: '' };
}

export function newSite(entityId: string): Site {
  return {
    id: uid('site'),
    name: '',
    entityId,
    labourTargetPct: 0.28,
    trackingCode: '',
    openMinute: 12 * 60,
    closeMinute: 23 * 60,
    // Blank on purpose: a forecast built on our numbers instead of theirs would look right and be wrong.
    salesProfile: { dailySales: [0, 0, 0, 0, 0, 0, 0], averageSpend: 0 },
  };
}

/**
 * A blank set-up. Companies already on record are kept, so a business that signed itself up starts
 * from the name it gave, not an empty form.
 */
export function emptyDraft(existing: SetupDraft['entities'] = []): SetupDraft {
  const entities = existing.length ? existing.map((e) => ({ ...e })) : [newEntity()];
  const site = newSite(entities[0].id);
  const roles = ROLE_TEMPLATE.map(({ rule: _rule, ...role }) => role);
  return { entities, sites: [site], roles, demandRules: roles.flatMap((r) => defaultRule(r, site.id) ?? []) };
}

export function draftFromState(state: RotaState): SetupDraft {
  return {
    entities: state.entities,
    sites: state.sites.map((s) => ({ ...s, salesProfile: s.salesProfile ?? profileFromForecast(state, s) })),
    roles: state.roles,
    demandRules: state.demandRules,
  };
}

/** A starting point for a site set up before typical weeks existed: its latest full forecast week. */
function profileFromForecast(state: RotaState, site: Site) {
  const rows = state.forecast.filter((f) => f.siteId === site.id);
  const dailySales = [0, 0, 0, 0, 0, 0, 0];
  if (rows.length === 0) return { dailySales, averageSpend: 0 };
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
  return { dailySales, averageSpend: covers ? Math.round(sales / covers) : 0 };
}

// Share of a typical day's takings by clock hour: breakfast, lunch peak, quiet afternoon, dinner peak.
const HOUR_WEIGHT = [
  0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.03, 0.04, 0.03, 0.02, 0.02,
  0.09, 0.11, 0.06, 0.03, 0.03, 0.06, 0.11, 0.15, 0.15, 0.1, 0.06, 0.03,
];

export function forecastForWeek(site: Site, start: string): HourForecast[] {
  const profile = site.salesProfile;
  if (!profile) return [];
  // Hours past midnight weigh as late evening does, tailing off: a bar's 01:00 is not a café's.
  const weight = (h: number) => (h < 24 ? HOUR_WEIGHT[h] : [0.04, 0.03, 0.02, 0.01][h - 24] ?? 0.01);
  const open = Array.from({ length: tradingDayHours(site) }, (_, h) => h).filter((h) => h * 60 >= site.openMinute && h * 60 < site.closeMinute);
  const total = open.reduce((sum, h) => sum + weight(h), 0);
  if (!total) return [];
  return weekDates(start).flatMap((date, day) => {
    const daySales = profile.dailySales[day] ?? 0;
    if (!(daySales > 0)) return [];
    // Round each hour but put the pennies on the last one so the day ties back to the profile.
    let allocated = 0;
    return open.map((hour, i) => {
      const sales = i === open.length - 1 ? daySales - allocated : Math.round((daySales * weight(hour)) / total);
      allocated += sales;
      const covers = profile.averageSpend > 0 ? Math.round(sales / profile.averageSpend) : 0;
      return { siteId: site.id, ...calendarHour(date, hour), sales, covers, source: 'profile' as const };
    });
  });
}

/** Profile rows for sites in `siteIds` that have nothing at all forecast in this week. */
export function missingForecast(state: RotaState, siteIds: string[], start: string): HourForecast[] {
  const dates = new Set(weekDates(start));
  return state.sites
    .filter((s) => siteIds.includes(s.id))
    // Sunday night's trade after midnight is stored on Monday: it is not a forecast for that week.
    .flatMap((site) => (state.forecast.some((f) => f.siteId === site.id && dates.has(f.date) && isOpenHour(site, f.hour)) ? [] : forecastForWeek(site, start)));
}

/** Weeks ahead the set-up writes a forecast for. The rota build fills any week after that on demand. */
export const FORECAST_WEEKS = 8;

/**
 * Re-forecasts from this week on: profile rows are replaced with the new typical week, except in
 * weeks where a sales system has sent its own figures for that site. Past weeks are the record.
 */
export function reforecast(prev: HourForecast[], sites: Site[], today: string): HourForecast[] {
  const start = weekStart(today);
  const siteIds = new Set(sites.map((s) => s.id));
  const kept = prev.filter((f) => siteIds.has(f.siteId) && (f.source !== 'profile' || f.date < start));
  const sent = new Set(kept.filter((f) => f.source !== 'profile' && f.date >= start).map((f) => `${f.siteId}|${weekStart(f.date)}`));
  const ahead = sites.flatMap((site) =>
    Array.from({ length: FORECAST_WEEKS }, (_, w) => addDays(start, w * 7))
      .filter((ws) => !sent.has(`${site.id}|${ws}`))
      .flatMap((ws) => forecastForWeek(site, ws)),
  );
  return [...kept, ...ahead];
}

export function validateSetup(draft: SetupDraft): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const block = (message: string) => issues.push({ severity: 'block', message });
  const warn = (message: string) => issues.push({ severity: 'warn', message });
  const duplicate = <T,>(items: T[], key: (x: T) => string) => {
    const seen = new Set<string>();
    return items.map(key).filter((k) => k && (seen.has(k) || !seen.add(k)));
  };

  if (draft.entities.length === 0) block('Add the company that employs your staff.');
  for (const e of draft.entities) {
    if (!e.name.trim()) block('Every company needs its registered name.');
    if (e.companyNumber && !/^(\d{8}|[A-Z]{2}\d{6})$/i.test(e.companyNumber.trim())) {
      warn(`${e.name || 'A company'}: company number ${e.companyNumber} is not the usual 8 characters. Check it on Companies House.`);
    }
    if (e.payeReference && !/^\d{3}\s*\/\s*[A-Z0-9]{1,10}$/i.test(e.payeReference.trim())) {
      warn(`${e.name || 'A company'}: PAYE reference should look like 120/AB12345.`);
    }
    if (!e.payeReference.trim()) warn(`${e.name || 'A company'}: no PAYE reference yet. Payroll cannot run for it without one.`);
  }
  if (draft.entities.length > 1) {
    for (const e of draft.entities) {
      if (!e.intercompanyCode.trim()) block(`${e.name || 'A company'}: with more than one company, each needs an intercompany balance code.`);
    }
    for (const code of duplicate(draft.entities, (e) => e.intercompanyCode.trim())) block(`Intercompany code ${code} is used by two companies.`);
  }

  // Travel between sites is paid working time, and how it is paid is the company's call to make.
  if (draft.sites.length > 1) {
    for (const e of draft.entities.filter((x) => !x.travelPay)) {
      warn(
        `${e.name || 'A company'}: choose how travel between sites is paid (Travel pay, on the Sites overview). Until then it is paid at each person's normal rate.`,
      );
    }
  }

  if (draft.sites.length === 0) block('Add at least one site.');
  for (const site of draft.sites) {
    const label = site.name.trim() || 'A site';
    if (!site.name.trim()) block('Every site needs a name.');
    if (!draft.entities.some((e) => e.id === site.entityId)) block(`${label}: choose the company it trades in.`);
    if (site.closeMinute <= site.openMinute) block(`${label}: closing time must be after opening time.`);
    if (site.closeMinute > LATEST_CLOSE) block(`${label}: closing can be after midnight, as late as opening time the next day.`);
    if (site.closeMinute - 1440 > site.openMinute) block(`${label}: trading would run into the next day's opening. Set it to open round the clock instead.`);
    if (!(site.labourTargetPct > 0 && site.labourTargetPct < 1)) block(`${label}: labour target must be between 0% and 100%.`);
    const profile = site.salesProfile;
    if (!profile || !profile.dailySales.some((d) => d > 0)) block(`${label}: enter typical net sales for at least one day.`);
    else if (!(profile.averageSpend > 0)) block(`${label}: enter an average spend per cover.`);
  }
  for (const name of duplicate(draft.sites, (s) => s.name.trim().toLowerCase())) block(`Two sites are called ${name}.`);

  if (draft.roles.length === 0) block('Add at least one role.');
  for (const role of draft.roles) {
    if (!role.name.trim()) block('Every role needs a name.');
    if (!role.nominalCode.trim()) block(`${role.name || 'A role'}: add the nominal code its wages post to.`);
  }
  for (const name of duplicate(draft.roles, (r) => r.name.trim().toLowerCase())) block(`Two roles are called ${name}.`);

  for (const rule of draft.demandRules) {
    const role = draft.roles.find((r) => r.id === rule.roleId)?.name ?? 'A role';
    const site = draft.sites.find((s) => s.id === rule.siteId)?.name ?? 'a site';
    if (rule.maximum < rule.minimumWhileOpen) block(`${role} at ${site}: maximum headcount is below the minimum.`);
    if (!(rule.coversPerHour! > 0) && !(rule.salesPerLabourHour! > 0)) block(`${role} at ${site}: set how many covers or how much in sales one person carries.`);
  }
  return issues;
}

/**
 * What the draft would remove that is still in use. Nothing in use is deleted: staff, rotas and
 * clocked time are payroll records, so a company, site or role has to be emptied first.
 */
export function removalBlocks(state: RotaState, draft: SetupDraft, timeEntries: { siteId: string; roleId: string }[] = []): string[] {
  const reasons: string[] = [];
  const keep = { entities: new Set(draft.entities.map((e) => e.id)), sites: new Set(draft.sites.map((s) => s.id)), roles: new Set(draft.roles.map((r) => r.id)) };
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  for (const e of state.entities.filter((x) => !keep.entities.has(x.id))) {
    const staff = state.employees.filter((p) => p.entityId === e.id).length;
    const sites = draft.sites.filter((s) => s.entityId === e.id).length;
    if (staff) reasons.push(`${e.name} employs ${count(staff, 'person', 'people')}. Move them or mark them as leavers first.`);
    if (sites) reasons.push(`${e.name} still has ${count(sites, 'site')} trading in it.`);
  }
  for (const s of state.sites.filter((x) => !keep.sites.has(x.id))) {
    const staff = state.employees.filter((p) => p.siteId === s.id || p.coverSiteIds.includes(s.id)).length;
    const shifts = state.shifts.filter((x) => x.siteId === s.id).length;
    const time = timeEntries.filter((t) => t.siteId === s.id).length;
    if (staff) reasons.push(`${s.name} is home or cover site for ${count(staff, 'person', 'people')}.`);
    if (shifts || time) reasons.push(`${s.name} has ${count(shifts, 'rostered shift')} and ${count(time, 'clocked time entry', 'clocked time entries')} on record.`);
  }
  for (const r of state.roles.filter((x) => !keep.roles.has(x.id))) {
    const staff = state.employees.filter((p) => p.roleIds.includes(r.id)).length;
    const used = state.shifts.filter((x) => x.roleId === r.id).length + timeEntries.filter((t) => t.roleId === r.id).length;
    if (staff) reasons.push(`${r.name} is held by ${count(staff, 'person', 'people')}.`);
    if (used) reasons.push(`${r.name} is on ${count(used, 'shift or time entry', 'shifts or time entries')} already worked or rostered.`);
  }
  return reasons;
}

export function applySetup(state: RotaState, draft: SetupDraft, today: string): RotaState {
  const sites = draft.sites.map((s) => ({ ...s, name: s.name.trim(), trackingCode: s.trackingCode.trim() || s.name.trim() }));
  const siteIds = new Set(sites.map((s) => s.id));
  const roleIds = new Set(draft.roles.map((r) => r.id));
  return {
    ...state,
    entities: draft.entities.map((e) => ({ ...e, name: e.name.trim(), companyNumber: e.companyNumber.trim(), payeReference: e.payeReference.trim(), intercompanyCode: e.intercompanyCode.trim() })),
    sites,
    roles: draft.roles.map((r) => ({ ...r, name: r.name.trim(), nominalCode: r.nominalCode.trim() })),
    demandRules: draft.demandRules.filter((r) => siteIds.has(r.siteId) && roleIds.has(r.roleId)),
    forecast: reforecast(state.forecast, sites, today),
  };
}

export interface PastedPerson {
  line: number;
  person: Pick<Employee, 'name' | 'roleIds' | 'payBasis' | 'hourlyRate' | 'annualSalary' | 'dateOfBirth' | 'contractedHours' | 'irregularHours' | 'startDate' | 'rightToWork'>;
}

/**
 * Reads a team list pasted from a spreadsheet or payroll export, one person per line:
 *   Name, Roles, Rate or salary, Date of birth, Contracted hours, Start date, Right to work checked on
 * The last two are optional. Roles are separated by "/" and matched to role names. Tabs or commas
 * both work. A blank start date means employed before records began, right for an existing team.
 * Without a right to work date the person cannot be rostered until the check is recorded in People.
 */
export function parseTeamPaste(text: string, roles: Role[]): { people: PastedPerson[]; errors: string[] } {
  const people: PastedPerson[] = [];
  const errors: string[] = [];
  const byName = new Map(roles.map((r) => [r.name.trim().toLowerCase(), r.id]));
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const cells = raw.split(raw.includes('\t') ? '\t' : ',').map((c) => c.trim());
    const [name, roleCell = '', payCell = '', dobCell = '', hoursCell = '', startCell = '', rtwCell = ''] = cells;
    if (i === 0 && /^name$/i.test(name)) return;
    const where = `Line ${i + 1}${name ? ` (${name})` : ''}`;
    const rowErrors: string[] = [];
    if (!name) rowErrors.push(`${where}: no name.`);
    const roleIds: string[] = [];
    for (const r of roleCell.split('/').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      const id = byName.get(r);
      if (id) roleIds.push(id);
      else rowErrors.push(`${where}: no role called "${r}".`);
    }
    if (roleIds.length === 0 && !rowErrors.some((e) => e.includes('no role'))) rowErrors.push(`${where}: no role given.`);
    const pay = Number(payCell.replace(/[£,\s]/g, ''));
    if (!(pay > 0)) rowErrors.push(`${where}: pay "${payCell}" is not a number.`);
    const dob = parseUkDate(dobCell);
    if (!dob) rowErrors.push(`${where}: date of birth "${dobCell}" not recognised. Use DD/MM/YYYY.`);
    const startDate = startCell ? parseUkDate(startCell) : undefined;
    if (startDate === null) rowErrors.push(`${where}: start date "${startCell}" not recognised. Use DD/MM/YYYY or leave it blank.`);
    const checkedOn = rtwCell ? parseUkDate(rtwCell) : undefined;
    if (checkedOn === null) rowErrors.push(`${where}: right to work date "${rtwCell}" not recognised. Use DD/MM/YYYY or leave it blank.`);
    if (rowErrors.length) return void errors.push(...rowErrors);
    const contracted = Number(hoursCell) || 0;
    // Anything over £1,000 is an annual salary, not an hourly rate.
    const salaried = pay > 1000;
    people.push({
      line: i + 1,
      person: {
        name,
        roleIds,
        payBasis: salaried ? 'salaried' : 'hourly',
        hourlyRate: salaried ? 0 : pay,
        annualSalary: salaried ? pay : 0,
        dateOfBirth: dob!,
        contractedHours: contracted,
        irregularHours: contracted === 0,
        ...(startDate ? { startDate } : {}),
        rightToWork: checkedOn ? { checked: true, checkedOn } : { checked: false },
      },
    });
  });
  return { people, errors };
}

/** Minimum wage warnings for pasted people, worked the same way as the People tab. */
export function pasteWarnings(people: PastedPerson[], today: string): string[] {
  return people.flatMap(({ line, person }) => {
    if (person.payBasis !== 'hourly') return [];
    const band = minimumWageFor(ageOn(person.dateOfBirth, today));
    return band && person.hourlyRate < band.hourly
      ? [`Line ${line} (${person.name}): £${person.hourlyRate.toFixed(2)} is below the ${band.label} of £${band.hourly.toFixed(2)}. Only correct for an apprentice.`]
      : [];
  });
}

export function parseUkDate(value: string): string | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Number.isNaN(parseISODate(v).getTime()) ? null : v;
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? (Number(m[3]) > 30 ? 1900 : 2000) + Number(m[3]) : Number(m[3]);
  const iso = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = parseISODate(iso);
  return d.getUTCDate() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) ? iso : null;
}
