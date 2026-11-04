// The onboarding workbook: one Excel file a new customer fills in (or pastes their old system's
// exports into) with their team, their rota and everyone's holiday position at go-live. Its headers
// are the names the importer reads first, so a filled-in template maps without help; its lists are
// the customer's own roles and sites, so what they type matches what is set up.

import type { RotaState } from './types';
import type { SheetOut } from './xlsx';

export const TEMPLATE_SHEETS = {
  team: 'Team', rtw: 'Right to work', documents: 'HR file', training: 'Training', holiday: 'Holiday balances', toil: 'TOIL', absences: 'Absences', rota: 'Rota',
} as const;

export const TEMPLATE_HEADERS = {
  team: ['Name', 'Email', 'Roles', 'Site', 'Hourly rate', 'Annual salary', 'Date of birth', 'Contracted hours', 'Start date', 'Right to work checked on'],
  rota: ['Name', 'Date', 'Start time', 'End time', 'Unpaid break', 'Role', 'Site'],
  holiday: ['Name', 'Accrued hours', 'Taken hours', 'Carried over hours', 'Remaining hours', 'Entitlement weeks'],
  rtw: ['Name', 'Right to work checked on', 'Evidence', 'Visa expiry', 'Term time hour limit'],
  documents: [
    'Name', 'Job title', 'Contract type', 'Written statement issued', 'Written statement signed', 'Handbook acknowledged', 'Probation end', 'Probation passed',
    'Fixed term end', 'Notice weeks', 'NI number', 'Address', 'Postcode', 'Emergency contact', 'Emergency contact relationship', 'Emergency contact phone', 'Line manager',
    'Document', 'Document date',
  ],
  training: ['Name', 'Course', 'Date completed', 'Expiry date', 'Provider'],
  toil: ['Name', 'TOIL balance hours', 'As at'],
  absences: ['Name', 'Absence type', 'First day', 'Last day', 'Reason', 'Fit note', 'Return to work date', 'Notes'],
};

const README: [string, string][] = [
  ['Preshift onboarding workbook', ''],
  ['', ''],
  ['What this is for', 'Bring your team, your rota and everyone\'s holiday position across from your old system in one go. Fill in the three sheets, or paste exports from your old rota, HR or payroll system into them, then upload this file in Preshift under Set-up, Import. Nothing is saved until you have checked a preview of every row.'],
  ['The order to do it in', '1. Team first: people must exist before anything else can be matched to them. 2. Right to work. 3. HR file. 4. Training. 5. Holiday balances. 6. TOIL. 7. Absences. 8. Rota, for the weeks ahead only. Each sheet is uploaded on its own tab under Import, from this same file.'],
  ['Copies of documents', 'Passports, share code checks, signed contracts, certificates and fit notes cannot come through a spreadsheet. The dates and details do; upload the copies on each person\'s file afterwards. For right to work, the copy is what gives you the statutory excuse.'],
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
  ['Right to work sheet', 'One row per person, for their current check.'],
  ['Right to work checked on', 'The date the documents were checked. Required: a check without its date is not a statutory excuse, so the row is left out.'],
  ['Evidence', 'What was seen: British passport, share code, BRP, birth certificate and NI letter.'],
  ['Visa expiry', 'For time-limited permission only. Leave blank, or write None, where there is no time limit.'],
  ['Term time hour limit', 'Students on a visa: the most hours a week allowed in term time.'],
  ['', ''],
  ['HR file sheet', 'Anything left blank stays as it is on Preshift. Dates as above.'],
  ['Contract type', 'Permanent, fixed term, casual (zero hours) or apprentice.'],
  ['Written statement issued and signed', 'The written statement of employment particulars is a day one right. Give the dates; upload the signed copy afterwards, or send it to sign in the staff app.'],
  ['NI number', 'Checked for a valid format. Without it payroll runs on an emergency basis.'],
  ['Emergency contact', 'Name and phone are both needed.'],
  ['Line manager', 'Their name, as on the Team sheet.'],
  ['Document and Document date', 'Any other document on file, such as a uniform policy or a signed opt-out, with the date it was signed or given.'],
  ['', ''],
  ['Training sheet', 'One row per certificate. Course names are matched to the courses inspectors ask for (food hygiene level 2 and 3, allergens, Challenge 25, personal licence, first aid, fire, manual handling, COSHH); anything else is kept under its own name.'],
  ['Expiry date', 'Leave blank to use the course\'s usual renewal, as when a course is recorded by hand. Write None for a certificate that does not expire.'],
  ['', ''],
  ['TOIL sheet', 'Time off in lieu owed to each person on the day you go live, in hours (or use a header with days in it, such as TOIL balance days). It becomes their opening balance; earned and taken are recorded on Preshift from then on.'],
  ['', ''],
  ['Absences sheet', 'Sickness and other absence, for absence triggers, the Bradford factor and return to work conversations. Twelve months back is enough.'],
  ['Absence type', 'Sickness, unauthorised, compassionate, dependants, maternity or paternity (family), unpaid, or anything else (kept as written). Holiday booked for days still to come is added as leave; holiday already taken is in the holiday balance, so it is not added twice. TOIL rows are left to the TOIL sheet.'],
  ['Last day', 'Blank for a single day. Write Ongoing for someone still off.'],
  ['Reason', 'Health data: kept on the HR file and shown only to those who read it.'],
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
    { name: TEMPLATE_SHEETS.rtw, header: true, rows: [TEMPLATE_HEADERS.rtw], widths: widths(TEMPLATE_HEADERS.rtw) },
    { name: TEMPLATE_SHEETS.documents, header: true, rows: [TEMPLATE_HEADERS.documents], widths: widths(TEMPLATE_HEADERS.documents) },
    { name: TEMPLATE_SHEETS.training, header: true, rows: [TEMPLATE_HEADERS.training], widths: widths(TEMPLATE_HEADERS.training) },
    { name: TEMPLATE_SHEETS.holiday, header: true, rows: [TEMPLATE_HEADERS.holiday], widths: widths(TEMPLATE_HEADERS.holiday) },
    { name: TEMPLATE_SHEETS.toil, header: true, rows: [TEMPLATE_HEADERS.toil], widths: widths(TEMPLATE_HEADERS.toil) },
    { name: TEMPLATE_SHEETS.absences, header: true, rows: [TEMPLATE_HEADERS.absences], widths: widths(TEMPLATE_HEADERS.absences) },
    { name: TEMPLATE_SHEETS.rota, header: true, rows: [TEMPLATE_HEADERS.rota], widths: widths(TEMPLATE_HEADERS.rota) },
    { name: 'Lists', header: true, rows: lists, widths: [28, 28] },
  ];
}
