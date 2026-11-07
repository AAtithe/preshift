// The onboarding workbook: one Excel file a new customer fills in (or pastes their old system's
// exports into) with their team, their rota and everyone's holiday position at go-live. Its headers
// are the names the importer reads first, so a filled-in template maps without help; its lists are
// the customer's own roles and sites, so what they type matches what is set up.

import type { RotaState } from './types';
import type { SheetOut } from './xlsx';

export const TEMPLATE_SHEETS = {
  team: 'Team', managers: 'Managers', rtw: 'Right to work', documents: 'HR file', training: 'Training', reviews: 'Reviews', holiday: 'Holiday balances', toil: 'TOIL',
  absences: 'Absences', hours: 'Past hours', takings: 'Takings', rota: 'Rota',
} as const;

export const TEMPLATE_HEADERS = {
  team: [
    'Name', 'Email', 'Roles', 'Site', 'Hourly rate', 'Annual salary', 'Date of birth', 'Contracted hours', 'Start date', 'Right to work checked on',
    '48 hour opt out', 'Maximum weekly hours', 'Pension enrolled', 'Pay frequency', 'Availability', 'Cover sites', 'Clock card',
  ],
  managers: ['Name', 'Email', 'Access role', 'Sites'],
  reviews: ['Name', 'Review type', 'Review date', 'Outcome', 'Next review', 'Notes'],
  hours: ['Name', 'Date worked', 'Clock in', 'Clock out', 'Unpaid break', 'Hours worked', 'Site'],
  takings: ['Site', 'Trading date', 'Net sales', 'Covers'],
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
  ['Preshift Rota onboarding workbook', ''],
  ['', ''],
  ['What this is for', 'Bring your team, your rota and everyone\'s holiday position across from your old system in one go. Fill in the three sheets, or paste exports from your old rota, HR or payroll system into them, then upload this file in Preshift Rota under Set-up, Import. Nothing is saved until you have checked a preview of every row.'],
  ['The order to do it in', 'The tabs under Import are numbered in this order. Team first: people must exist before anything else can be matched to them. Then managers, right to work, HR file, training, reviews, holiday balances, TOIL, absences, past hours, takings, and the rota for the weeks ahead last. Each sheet is uploaded on its own tab, from this same file. Every upload can be undone from Recent uploads.'],
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
  ['48 hour opt out', 'Yes only where they have signed one. Never for under 18s, who cannot opt out. Keep the signed copy.'],
  ['Maximum weekly hours', 'The most they will work in a week. Blank means 48.'],
  ['Pension enrolled', 'Yes, or No where they have opted out or are not eligible. Blank means enrolled.'],
  ['Pay frequency', 'Weekly or Monthly: it sets their minimum wage pay period.'],
  ['Availability', 'When they can work: Any, Mon-Fri 09:00-17:00, or Weekends; separate several with a semicolon. Blank means any time.'],
  ['Cover sites', 'Other sites they have agreed to work at, separated by commas.'],
  ['Clock card', 'The number on their clock card or fob, if they have one.'],
  ['Right to work checked on', 'The date you checked their documents. Without it they are added but cannot be rostered until the check is recorded with a copy. That is the law: the civil penalty is up to £60,000 per illegal worker.'],
  ['', ''],
  ['Reviews sheet', 'Probation reviews, appraisals and one-to-ones. A probation review with an outcome of Passed sets the probation passed date. Disciplinary, grievance and capability cases are never imported: record them by hand under Cases.'],
  ['', ''],
  ['Holiday balances sheet', 'Everyone\'s position on the day you go live, in hours. Headers that say days (Taken days) are read as days and turned into hours on each person\'s contracted day.'],
  ['Accrued hours', 'Irregular hours staff only: holiday built up so far this leave year. Fixed hours staff earn theirs evenly from the dates, so Preshift Rota works it out.'],
  ['Taken hours', 'Holiday taken so far this leave year, before Preshift Rota.'],
  ['Carried over hours', 'Untaken holiday brought in from last leave year.'],
  ['Remaining hours', 'Use this instead of accrued and taken if it is all your old system gives. For fixed hours staff it is read as the year\'s entitlement left.'],
  ['Entitlement weeks', 'Fixed hours staff on more than the statutory 5.6 weeks.'],
  ['', ''],
  ['Managers sheet', 'Everyone who needs their own sign-in to run the rota or the business. Each is invited by email to choose their own password.'],
  ['Access role', 'General manager, assistant manager, head chef, supervisor, area manager, operations director, finance director, payroll manager or people manager. An owner is never made from a file.'],
  ['Sites', 'For roles that run sites: the sites, separated by commas.'],
  ['', ''],
  ['Right to work sheet', 'One row per person, for their current check.'],
  ['Right to work checked on', 'The date the documents were checked. Required: a check without its date is not a statutory excuse, so the row is left out.'],
  ['Evidence', 'What was seen: British passport, share code, BRP, birth certificate and NI letter.'],
  ['Visa expiry', 'For time-limited permission only. Leave blank, or write None, where there is no time limit.'],
  ['Term time hour limit', 'Students on a visa: the most hours a week allowed in term time.'],
  ['', ''],
  ['HR file sheet', 'Anything left blank stays as it is on Preshift Rota. Dates as above.'],
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
  ['TOIL sheet', 'Time off in lieu owed to each person on the day you go live, in hours (or use a header with days in it, such as TOIL balance days). It becomes their opening balance; earned and taken are recorded on Preshift Rota from then on.'],
  ['', ''],
  ['Absences sheet', 'Sickness and other absence, for absence triggers, the Bradford factor and return to work conversations. Twelve months back is enough.'],
  ['Absence type', 'Sickness, unauthorised, compassionate, dependants, maternity or paternity (family), unpaid, or anything else (kept as written). Holiday booked for days still to come is added as leave; holiday already taken is in the holiday balance, so it is not added twice. TOIL rows are left to the TOIL sheet.'],
  ['Last day', 'Blank for a single day. Write Ongoing for someone still off.'],
  ['Reason', 'Health data: kept on the HR file and shown only to those who read it.'],
  ['', ''],
  ['Past hours sheet', 'Hours worked over at least the last 17 weeks, from timesheets or payroll. They were paid by your old payroll, so Preshift Rota never sends them to payroll: they are history for the 48 hour average, night work, guaranteed hours offers and holiday accrual.'],
  ['Clock in and Clock out', 'Best: night work and rest are measured from the times. A row with Hours worked only is placed from 09:00. A row per week also works: use a Week ending column with Hours worked, and it is spread over Monday to Friday.'],
  ['', ''],
  ['Takings sheet', 'Takings by site and day, net of VAT, for at least the last eight weeks, so the forecast learns how each site trades. Days your till has already sent are kept as they are.'],
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
    { name: TEMPLATE_SHEETS.managers, header: true, rows: [TEMPLATE_HEADERS.managers], widths: widths(TEMPLATE_HEADERS.managers) },
    { name: TEMPLATE_SHEETS.rtw, header: true, rows: [TEMPLATE_HEADERS.rtw], widths: widths(TEMPLATE_HEADERS.rtw) },
    { name: TEMPLATE_SHEETS.documents, header: true, rows: [TEMPLATE_HEADERS.documents], widths: widths(TEMPLATE_HEADERS.documents) },
    { name: TEMPLATE_SHEETS.training, header: true, rows: [TEMPLATE_HEADERS.training], widths: widths(TEMPLATE_HEADERS.training) },
    { name: TEMPLATE_SHEETS.reviews, header: true, rows: [TEMPLATE_HEADERS.reviews], widths: widths(TEMPLATE_HEADERS.reviews) },
    { name: TEMPLATE_SHEETS.holiday, header: true, rows: [TEMPLATE_HEADERS.holiday], widths: widths(TEMPLATE_HEADERS.holiday) },
    { name: TEMPLATE_SHEETS.toil, header: true, rows: [TEMPLATE_HEADERS.toil], widths: widths(TEMPLATE_HEADERS.toil) },
    { name: TEMPLATE_SHEETS.absences, header: true, rows: [TEMPLATE_HEADERS.absences], widths: widths(TEMPLATE_HEADERS.absences) },
    { name: TEMPLATE_SHEETS.hours, header: true, rows: [TEMPLATE_HEADERS.hours], widths: widths(TEMPLATE_HEADERS.hours) },
    { name: TEMPLATE_SHEETS.takings, header: true, rows: [TEMPLATE_HEADERS.takings], widths: widths(TEMPLATE_HEADERS.takings) },
    { name: TEMPLATE_SHEETS.rota, header: true, rows: [TEMPLATE_HEADERS.rota], widths: widths(TEMPLATE_HEADERS.rota) },
    { name: 'Lists', header: true, rows: lists, widths: [28, 28] },
  ];
}
