// The onboarding workbook: one Excel file a new customer fills in (or pastes their old system's
// exports into) with their team, their rota and everyone's holiday position at go-live. Its headers
// are the names the importer reads first, so a filled-in template maps without help; its lists are
// the customer's own roles and sites, so what they type matches what is set up.

import type { RotaState } from './types';
import type { SheetOut } from './xlsx';

export const TEMPLATE_SHEETS = { team: 'Team', rota: 'Rota', holiday: 'Holiday balances' } as const;

export const TEMPLATE_HEADERS = {
  team: ['Name', 'Email', 'Roles', 'Site', 'Hourly rate', 'Annual salary', 'Date of birth', 'Contracted hours', 'Start date', 'Right to work checked on'],
  rota: ['Name', 'Date', 'Start time', 'End time', 'Unpaid break', 'Role', 'Site'],
  holiday: ['Name', 'Accrued hours', 'Taken hours', 'Carried over hours', 'Remaining hours', 'Entitlement weeks'],
};

const README: [string, string][] = [
  ['Preshift onboarding workbook', ''],
  ['', ''],
  ['What this is for', 'Bring your team, your rota and everyone\'s holiday position across from your old system in one go. Fill in the three sheets, or paste exports from your old rota, HR or payroll system into them, then upload this file in Preshift under Set-up, Import. Nothing is saved until you have checked a preview of every row.'],
  ['The order to do it in', '1. Team first: people must exist before they can be on a rota or have a holiday balance. 2. Holiday balances. 3. Rota, for the weeks ahead only.'],
  ['Dates', 'Day first, as 09/11/2026, or 2026-11-09. American dates (month first) can be switched on when you upload.'],
  ['Times', '24 hour, as 17:30, or 5:30pm. A finish earlier than the start runs past midnight: 18:00 to 02:00 is an eight hour close.'],
  ['', ''],
  ['Team sheet', ''],
  ['Name', 'Full name as it should show on the rota. Required.'],
  ['Email', 'Their own email, for the staff app invitation. Optional, but it is also how rota and holiday rows find them when two people share a name.'],
  ['Roles', 'One or more of the roles on the Lists sheet, separated by a slash: Server/Host. Required.'],
  ['Site', 'Their home site, from the Lists sheet. Leave blank to use the site you choose when uploading.'],
  ['Hourly rate or Annual salary', 'One of the two. Required. Rates go to your finance director for approval, as any pay change does. Below the minimum wage for their age is flagged.'],
  ['Date of birth', 'Required. It sets their minimum wage band and the young worker rules. Nothing is guessed.'],
  ['Contracted hours', 'Guaranteed hours a week. Blank or 0 means irregular hours: holiday then accrues at 12.07% of hours worked.'],
  ['Start date', 'Blank for people already working for you.'],
  ['Right to work checked on', 'The date you checked their documents. Without it they are added but cannot be rostered until the check is recorded with a copy. That is the law: the civil penalty is up to £60,000 per illegal worker.'],
  ['', ''],
  ['Holiday balances sheet', 'Everyone\'s position on the day you go live, in hours. Headers that say days (Taken days) are read as days and turned into hours on each person\'s contracted day.'],
  ['Accrued hours', 'Irregular hours staff only: holiday built up so far this leave year. Fixed hours staff earn theirs evenly from the dates, so Preshift works it out.'],
  ['Taken hours', 'Holiday taken so far this leave year, before Preshift.'],
  ['Carried over hours', 'Untaken holiday brought in from last leave year.'],
  ['Remaining hours', 'Use this instead of accrued and taken if it is all your old system gives. For fixed hours staff it is read as the year\'s entitlement left.'],
  ['Entitlement weeks', 'Fixed hours staff on more than the statutory 5.6 weeks.'],
  ['', ''],
  ['Rota sheet', 'Shifts for the weeks ahead, one row per shift. They arrive as a draft: check them against the forecast and publish as normal. A shift already on the rota is not added twice. Open shifts with nobody on them are left for you to post from the rota.'],
  ['Name', 'As on the Team sheet.'],
  ['Date, Start time, End time', 'Required.'],
  ['Unpaid break', 'Minutes (30), or hours and minutes (0:30).'],
  ['Role', 'From the Lists sheet. Blank uses the person\'s first role.'],
  ['Site', 'From the Lists sheet. Blank uses the site you choose when uploading.'],
  ['', ''],
  ['Exports from another system', 'Columns are found by their names, in any order, so an export from your old rota, HR or payroll system can be uploaded as it is. Where a column is not recognised, you choose it by hand, or ask Shifty to map the columns: Shifty is shown the headers and the kind of value in each, never names, emails or other personal details.'],
];

/** The workbook for an organisation: instructions, the three sheets, and its own roles and sites to choose from. */
export function onboardingTemplate(state: Pick<RotaState, 'roles' | 'sites'>): SheetOut[] {
  const roles = state.roles.map((r) => r.name);
  const sites = state.sites.map((s) => s.name);
  const lists: string[][] = [['Roles', 'Sites']];
  for (let i = 0; i < Math.max(roles.length, sites.length); i++) lists.push([roles[i] ?? '', sites[i] ?? '']);
  const widths = (headers: string[]) => headers.map((h) => Math.max(14, h.length + 4));
  return [
    { name: 'Read me', rows: README, widths: [32, 110], wrap: true },
    { name: TEMPLATE_SHEETS.team, header: true, rows: [TEMPLATE_HEADERS.team], widths: widths(TEMPLATE_HEADERS.team) },
    { name: TEMPLATE_SHEETS.holiday, header: true, rows: [TEMPLATE_HEADERS.holiday], widths: widths(TEMPLATE_HEADERS.holiday) },
    { name: TEMPLATE_SHEETS.rota, header: true, rows: [TEMPLATE_HEADERS.rota], widths: widths(TEMPLATE_HEADERS.rota) },
    { name: 'Lists', header: true, rows: lists, widths: [28, 28] },
  ];
}
