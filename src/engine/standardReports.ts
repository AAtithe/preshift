// Ready-made reports for every area of the app. Each is only a definition on a dataset, so the
// builder can open any of them as a starting point and change it. Dates are named ranges, so a
// report run next month covers next month's figures.

import type { ReportArea, ReportDefinition } from './reportBuilder';

export interface StandardReport {
  id: string;
  name: string;
  area: ReportArea;
  /** What the report answers, and what to do with the answer. */
  description: string;
  definition: ReportDefinition;
}

const notLeft = [{ field: 'status', op: 'isNot' as const, values: ['Left'] }];

export const STANDARD_REPORTS: StandardReport[] = [
  // People
  {
    id: 'turnover-by-site',
    name: 'Staff turnover by site',
    area: 'people',
    description: 'Leavers over average headcount for the last 12 months, site by site. Hospitality runs high; the question is which site runs higher than the rest, and why.',
    definition: { dataset: 'movements', groupBy: ['site'], measures: ['headcount', 'starters', 'leavers', 'turnover', 'earlyLeavers'], range: 'last-12-months', sort: { by: 'turnover', direction: 'desc' } },
  },
  {
    id: 'turnover-by-month',
    name: 'Starters, leavers and turnover by month',
    area: 'people',
    description: 'Headcount at each month end with who joined and who left. Shows the seasonal pattern, so hiring starts before the peak, not during it.',
    definition: { dataset: 'movements', groupBy: ['month'], measures: ['headcount', 'starters', 'leavers', 'turnover'], range: 'last-12-months' },
  },
  {
    id: 'turnover-by-department',
    name: 'Turnover by department',
    area: 'people',
    description: 'Kitchen, front of house, bar and management side by side. A kitchen losing people faster than the floor is a different problem from the other way round.',
    definition: { dataset: 'movements', groupBy: ['department'], measures: ['headcount', 'leavers', 'turnover', 'earlyLeavers', 'earlyRate'], range: 'last-12-months' },
  },
  {
    id: 'early-leavers',
    name: 'Leavers within 90 days',
    area: 'people',
    description: 'People who left inside three months, by site. A high share points at hiring or onboarding, not pay.',
    definition: { dataset: 'movements', groupBy: ['site'], measures: ['leavers', 'earlyLeavers', 'earlyRate'], range: 'last-12-months', sort: { by: 'earlyRate', direction: 'desc' } },
  },
  {
    id: 'headcount',
    name: 'Headcount by site and department',
    area: 'people',
    description: 'Everyone employed now, and starting soon, by site and department.',
    definition: { dataset: 'people', groupBy: ['site', 'department'], measures: ['current', 'contracted'], filters: notLeft },
  },
  {
    id: 'length-of-service',
    name: 'Length of service',
    area: 'people',
    description: 'How long the current team has been with you. A team mostly under a year needs more training and supervision on the rota.',
    definition: { dataset: 'people', groupBy: ['service'], measures: ['current'], filters: notLeft },
  },
  {
    id: 'age-profile',
    name: 'Age profile',
    area: 'people',
    description: 'The current team by age band. Under 18s carry their own working time rules and minimum wage.',
    definition: { dataset: 'people', groupBy: ['age'], measures: ['current'], filters: notLeft },
  },
  {
    id: 'contract-mix',
    name: 'Contract and hours mix',
    area: 'people',
    description: 'Permanent, fixed term, casual and apprentice, and how many have guaranteed hours. Guaranteed hours are paid whether rostered or not.',
    definition: { dataset: 'people', groupBy: ['contract', 'hours'], measures: ['current', 'contracted'], filters: notLeft },
  },
  {
    id: 'absence-by-site',
    name: 'Absence by site',
    area: 'people',
    description: 'Spells and days off over the last 12 months, site by site.',
    definition: { dataset: 'absence', groupBy: ['site'], measures: ['spells', 'days', 'people', 'avgDays', 'rtwRate'], range: 'last-12-months', sort: { by: 'days', direction: 'desc' } },
  },
  {
    id: 'absence-by-type',
    name: 'Absence by type',
    area: 'people',
    description: 'Sickness, compassionate, dependants and the rest. Shown to HR and payroll only.',
    definition: { dataset: 'absence', groupBy: ['type'], measures: ['spells', 'days', 'people'], range: 'last-12-months' },
  },
  {
    id: 'absence-by-month',
    name: 'Absence by month',
    area: 'people',
    description: 'Days off month by month: winter illness, school holidays and anything that does not fit the pattern.',
    definition: { dataset: 'absence', groupBy: ['month'], measures: ['spells', 'days'], range: 'last-12-months' },
  },
  {
    id: 'bradford',
    name: 'Bradford scores',
    area: 'people',
    description: 'Average Bradford score and how many people are over 50 (review) by site. Short, frequent absence costs more cover than one long spell.',
    definition: { dataset: 'people', groupBy: ['site'], measures: ['current', 'bradford', 'bradfordReview'], filters: notLeft },
  },
  {
    id: 'training-compliance',
    name: 'Training compliance by site',
    area: 'people',
    description: 'Certificates the roles need, held and in date, as a share. What an EHO, licensing officer or insurer asks to see.',
    definition: { dataset: 'training', groupBy: ['site'], measures: ['required', 'valid', 'compliance', 'missing'], sort: { by: 'compliance', direction: 'asc' } },
  },
  {
    id: 'training-by-course',
    name: 'Training compliance by course',
    area: 'people',
    description: 'Each required course across the group: who holds it and who does not.',
    definition: { dataset: 'training', groupBy: ['course'], measures: ['required', 'valid', 'compliance', 'missing'] },
  },
  {
    id: 'holiday-balances',
    name: 'Holiday balances and provision',
    area: 'people',
    description: 'Entitlement, taken, booked and remaining by site, with the holiday pay provision for the balance sheet.',
    definition: { dataset: 'holiday', groupBy: ['site'], measures: ['people', 'entitlement', 'taken', 'booked', 'remaining', 'liability'] },
  },
  {
    id: 'onboarding',
    name: 'Onboarding progress',
    area: 'people',
    description: 'Starters by site and state: complete, on track, late or blocked.',
    definition: { dataset: 'onboarding', groupBy: ['site', 'state'], measures: ['starters', 'progress', 'lateSteps'] },
  },
  {
    id: 'requests',
    name: 'Staff requests and response times',
    area: 'people',
    description: 'What the team asked for in the app, how much was approved, and how long they waited for an answer. Slow answers cost goodwill.',
    definition: { dataset: 'requests', groupBy: ['kind'], measures: ['requests', 'approved', 'declined', 'approvalRate', 'hoursToDecide', 'waiting'], range: 'last-13-weeks' },
  },
  {
    id: 'reviews',
    name: 'Reviews and training recorded',
    area: 'people',
    description: 'Probation reviews, appraisals, one-to-ones and courses recorded over the last 12 months.',
    definition: { dataset: 'reviews', groupBy: ['kind', 'detail'], measures: ['records', 'people'], range: 'last-12-months' },
  },
  {
    id: 'cases',
    name: 'Cases by type and outcome',
    area: 'people',
    description: 'Disciplinary, grievance, capability and investigations, open and closed. Shown only to people who may see cases.',
    definition: { dataset: 'cases', groupBy: ['kind', 'status'], measures: ['cases'], range: 'last-12-months' },
  },
  {
    id: 'recognition',
    name: 'Recognition by site',
    area: 'people',
    description: 'Thank-yous and points given, and how many of the team were recognised.',
    definition: { dataset: 'recognition', groupBy: ['site'], measures: ['recognitions', 'points', 'people'], range: 'last-13-weeks' },
  },
  // Time and attendance
  {
    id: 'lateness-by-site',
    name: 'Late arrivals by site',
    area: 'time',
    description: 'Clock-ins more than 10 minutes after the rostered start, as a share of rostered clock-ins.',
    definition: { dataset: 'time', groupBy: ['site'], measures: ['onRota', 'late', 'lateRate', 'minutesLate'], range: 'last-13-weeks', sort: { by: 'lateRate', direction: 'desc' } },
  },
  {
    id: 'lateness-by-person',
    name: 'Late arrivals by person',
    area: 'time',
    description: 'Who is most often late, so the conversation is about a pattern, not one bad morning.',
    definition: { dataset: 'time', groupBy: ['site', 'person'], measures: ['onRota', 'late', 'lateRate'], range: 'last-13-weeks', sort: { by: 'late', direction: 'desc' }, limit: 50 },
  },
  {
    id: 'no-shows',
    name: 'No-shows',
    area: 'time',
    description: 'Published shifts on past days with nobody clocked, at sites that clock.',
    definition: { dataset: 'attendance', groupBy: ['site'], measures: ['shifts', 'noShows', 'noShowRate'], range: 'last-13-weeks', sort: { by: 'noShowRate', direction: 'desc' } },
  },
  {
    id: 'clock-method',
    name: 'How the team clocks in',
    area: 'time',
    description: 'Card, device, phone or entered by a manager, by site. Manual entries are the ones to question.',
    definition: { dataset: 'time', groupBy: ['site', 'method'], measures: ['entries'], range: 'last-13-weeks' },
  },
  {
    id: 'break-shortfalls',
    name: 'Break shortfalls',
    area: 'time',
    description: 'Shifts where the legal break was not taken, by site and kind. Each is a working time breach waiting to be raised.',
    definition: { dataset: 'breaks', groupBy: ['site', 'kind'], measures: ['shortfalls', 'minutesShort', 'people'], range: 'last-13-weeks' },
  },
  {
    id: 'hours-by-role',
    name: 'Clocked hours by role',
    area: 'time',
    description: 'Paid hours actually worked, role by role.',
    definition: { dataset: 'time', groupBy: ['role'], measures: ['hours', 'people', 'entries'], range: 'last-4-weeks', sort: { by: 'hours', direction: 'desc' } },
  },
  {
    id: 'unrostered-clocking',
    name: 'Clocking with no shift',
    area: 'time',
    description: 'Clock-ins with no rostered shift behind them, by site: the hours nobody planned.',
    definition: { dataset: 'time', groupBy: ['site'], measures: ['entries', 'unrostered', 'hours'], range: 'last-13-weeks', sort: { by: 'unrostered', direction: 'desc' } },
  },
  // Rota and compliance
  {
    id: 'compliance-by-rule',
    name: 'Compliance issues by rule',
    area: 'rota',
    description: 'What the compliance check found on the rota over the last 13 weeks, rule by rule.',
    definition: { dataset: 'compliance', groupBy: ['rule'], measures: ['issues', 'blocking', 'people'], range: 'last-13-weeks', sort: { by: 'issues', direction: 'desc' } },
  },
  {
    id: 'rest-overrides',
    name: 'Rest overrides',
    area: 'rota',
    description: 'Rest breaches published with a manager’s reason, by site and rule. A site that overrides every week has a staffing problem.',
    definition: { dataset: 'overrides', groupBy: ['site', 'rule'], measures: ['overrides', 'people'], range: 'last-13-weeks' },
  },
  {
    id: 'open-shift-fill',
    name: 'Open shift fill rate',
    area: 'rota',
    description: 'Shifts posted for anyone to pick up, and how many were taken.',
    definition: { dataset: 'openShifts', groupBy: ['site'], measures: ['posted', 'filled', 'fillRate', 'hours'], range: 'last-13-weeks' },
  },
  {
    id: 'rota-by-weekday',
    name: 'Rota hours by day of the week',
    area: 'rota',
    description: 'Where the rostered hours fall across the week.',
    definition: { dataset: 'shifts', groupBy: ['weekday'], measures: ['shifts', 'hours', 'people'], range: 'last-4-weeks' },
  },
  // Labour and sales
  {
    id: 'labour-by-site',
    name: 'Labour % by site',
    area: 'labour',
    description: 'Sales, labour cost and labour % against target for the last 13 weeks, site by site.',
    definition: { dataset: 'labour', groupBy: ['site'], measures: ['sales', 'labour', 'labourPct', 'target', 'variance', 'splh'], range: 'last-13-weeks', sort: { by: 'labourPct', direction: 'desc' } },
  },
  {
    id: 'labour-by-week',
    name: 'Labour % by week',
    area: 'labour',
    description: 'The group week by week: sales, labour and labour %.',
    definition: { dataset: 'labour', groupBy: ['week'], measures: ['sales', 'labour', 'labourPct', 'variance', 'hours'], range: 'last-13-weeks' },
  },
  {
    id: 'forecast-accuracy',
    name: 'Forecast accuracy by site',
    area: 'labour',
    description: 'How far the forecast was from takings, and whether it runs high or low. A forecast that runs high costs labour every week.',
    definition: { dataset: 'takings', groupBy: ['site'], measures: ['sales', 'forecast', 'errorRate', 'bias'], range: 'last-13-weeks' },
  },
  {
    id: 'spend-per-head',
    name: 'Covers and spend per head',
    area: 'labour',
    description: 'Covers and average spend by site and day of the week, where the till or booking system records covers.',
    definition: { dataset: 'takings', groupBy: ['site', 'weekday'], measures: ['sales', 'covers', 'spend'], range: 'last-13-weeks' },
  },
  {
    id: 'coach-moves',
    name: 'Rota coach take-up',
    area: 'labour',
    description: 'Moves the coach offered, how many GMs took, and the saving taken against the saving offered.',
    definition: { dataset: 'coach', groupBy: ['site'], measures: ['moves', 'taken', 'takenRate', 'saving', 'savingTaken'], range: 'last-13-weeks' },
  },
  // Payroll and pay
  {
    id: 'pay-changes',
    name: 'Pay changes',
    area: 'payroll',
    description: 'Pay changes asked for over the last 12 months, by status, with the average rise.',
    definition: { dataset: 'payChanges', groupBy: ['status'], measures: ['changes', 'avgRise'], range: 'last-12-months' },
  },
  {
    id: 'pay-run-accuracy',
    name: 'Accrual accuracy by company',
    area: 'payroll',
    description: 'Pay runs against the week-end accrual, by company: the evidence behind a 3-day close.',
    definition: { dataset: 'payRuns', groupBy: ['company'], measures: ['runs', 'accrued', 'actual', 'variance', 'insideRate'], range: 'last-12-months' },
  },
  // Guests
  {
    id: 'booking-no-shows',
    name: 'Bookings and no-shows',
    area: 'guests',
    description: 'Bookings, covers, cancellations and no-shows by site. A high no-show rate is staffing paid for and not used.',
    definition: { dataset: 'bookings', groupBy: ['site'], measures: ['bookings', 'covers', 'noShows', 'noShowRate', 'cancelled'], range: 'last-13-weeks' },
  },
  // Access and organisation
  {
    id: 'access-review',
    name: 'Access review',
    area: 'organisation',
    description: 'Everyone who can sign in, by role: without an authenticator, and not seen in 90 days. What a quarterly access review checks.',
    definition: { dataset: 'access', groupBy: ['role'], measures: ['people', 'noMfa', 'dormant'] },
  },
  {
    id: 'support',
    name: 'Support requests',
    area: 'organisation',
    description: 'Questions, problems and ideas raised, by kind and status, with the average time to a first answer.',
    definition: { dataset: 'support', groupBy: ['kind', 'status'], measures: ['tickets', 'hoursToRespond'], range: 'last-12-months' },
  },
];
