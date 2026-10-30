// What's new, walked through in the app. One release a week, newest first, written alongside the
// README card. Demo and live run this same file, so a release reaches both with the build that
// carries it, and a release written ahead of its week goes out by itself on that Monday.
import { weekStart } from '../engine/time';
import type { Tab } from './nav';

export type RotaLens = 'timeline' | 'people' | 'gantt' | 'cover' | 'rest' | 'stations' | 'cost' | 'changes' | 'fairness';

export interface WalkStep {
  /** Who it is for, as on the README card: GMs, Staff, Finance, Admin, Owners, WS, Everyone. */
  for: string;
  title: string;
  /** What changed and why it matters, in two or three sentences. */
  body: string;
  /** One thing to try while the screen is open. */
  tryIt?: string;
  /** The section the step opens. Shown only to people offered that section; with none, shown to everyone. */
  tab?: Tab;
  /** On the Rota tab, the view the step opens. */
  lens?: RotaLens;
}

export interface Release {
  /** The Monday of the week it goes out, YYYY-MM-DD. Hidden until that day. */
  week: string;
  /** The week's test, from the foot of the README card. */
  test: string;
  steps: WalkStep[];
}

export const RELEASES: Release[] = [
  {
    week: '2026-10-26',
    test: 'Publish next week at one site, then move one shift. By Monday, check Rota seen on Staff requests: everyone working that week should have confirmed the version they will turn up to, and anyone who has not is the first conversation of the week.',
    steps: [
      {
        for: 'GMs',
        title: 'Rota seen',
        body: 'When a week is published, or a published shift moves, the staff app asks each person to confirm their week as it now reads. Staff requests shows who has confirmed this week and next, who saw an earlier version, and who has no app. Nobody can say they were not told.',
        tryIt: 'Open Rota seen and find who has not confirmed this week.',
        tab: 'requests',
      },
      {
        for: 'GMs',
        title: 'Gantt',
        body: 'A new view on the Rota tab: one line per person, their shifts as bars against the clock, by department in the order people start. The whole week shows who is on when and who is idle; one day by the hour adds heads on against heads needed beneath. Drag a bar to move it or change its hours, drop it on another person to hand it over, or drag across an empty line to add a shift, with the labour % shown as you go.',
        tryIt: 'Click your busiest day\'s name, find the hour where everyone starts at once, and drag one start an hour later into the evening.',
        tab: 'rota',
        lens: 'gantt',
      },
      {
        for: 'Owners',
        title: 'Areas within a site',
        body: 'Set-up, then Trading and staffing: split a site into areas (front of house, back of house, a bakery) and choose the area each role works in there. Every shift lands in its role\'s area, and a shift worked elsewhere that day can name its own. Reports, then Cost by role, splits labour by area with every on-cost, and the Gantt groups and filters by area.',
        tryIt: 'Split one site into areas, then open Cost by role for that site and read what each area costs as a share of the site\'s labour.',
        tab: 'setup',
      },
      {
        for: 'GMs',
        title: 'Phone tags',
        body: 'Staff can now clock by touching their own phone to a secure NFC sticker at the staff entrance, iPhone or Android, with no card, no app to install and no location needed. Each touch writes a one-time code only that sticker can make, so a link sent to someone at home clocks nobody.',
        tryIt: 'Open Clock-in setup and add a phone tag for the staff entrance.',
        tab: 'clock',
      },
      {
        for: 'Staff',
        title: 'Seen it, in the staff app',
        body: 'A published week, or a change to it, now asks each person to tap Seen it. A later change asks again. It takes a second, and it is the record that they knew.',
      },
      {
        for: 'Operators',
        title: 'Overdue requests go up a level',
        body: 'A request still waiting after two days is marked Overdue and goes into the morning email of whoever sits above the site\'s manager, named with the GM as the person to decide. Area managers stop getting every request and see only what has stalled.',
        tab: 'requests',
      },
      {
        for: 'Operators',
        title: 'Saw the rota, by site',
        body: 'Staff app adoption gains Saw the rota: the share of each site\'s team who confirmed their week. A site where people do not read the rota is a site where people miss shifts.',
        tab: 'adoption',
      },
      {
        for: 'Finance',
        title: 'Tronc in Labour cash',
        body: 'Each person\'s share of the tips now leaves on the scheme\'s payout day, or with the pay for the days it was taken, and the HMRC payment shows how much of it is on tronc. An employer allocation carries NI and pension; an independent tronc carries neither. Tips past the legal deadline are flagged.',
        tab: 'cash',
      },
      {
        for: 'Finance',
        title: 'Tronc payout day',
        body: 'Each tronc scheme records the day it pays out, set in the scheme editor and shown on the Tronc screen. The cash calendar uses it, so tips leave the bank on the day they really do.',
        tab: 'tronc',
      },
      {
        for: 'Staff',
        title: 'Tips and payslips in the staff app',
        body: 'A Pay tab shows each person their own tips week by week, paid or the date they must be paid by, and how tips are shared at their site. Payslips and P60s come straight from payroll when asked. It is the tips record the Employment (Allocation of Tips) Act 2023 entitles them to, without a request to the office.',
      },
      {
        for: 'Finance',
        title: 'Tips through payroll',
        body: 'Where a site pays tips in each pay run, each person\'s share now goes to TeamPay with their hours, free of Class 1 NI where an independent troncmaster allocated it, and is marked paid at the period end. Tips are paid on time, in full and on the payslip.',
        tab: 'payroll',
      },
      {
        for: 'WS',
        title: 'One Claude connection for every client',
        body: 'Connecting Claude to Preshift now offers every client you work in, all ticked, and says which are left out and why. Claude acts as you in each one, with your access there, so a client partner asks across their whole book from one place. Connected apps lists every connection and its clients.',
        tab: 'clients',
      },
      {
        for: 'Owners',
        title: 'Choose which features you use',
        body: 'Organisation, then Features: switch off the parts of Preshift your business does not use, such as Tronc, Prime cost or HR files, and they leave the bar at the top of the screen for everyone. Nothing is deleted and nobody\'s access changes; switching one back on restores it as it was. Benchmarking and open shifts approved without a manager sit on the same screen, and every change is recorded with who made it.',
        tryIt: 'Count the sections your team never opens, then switch them off once your GMs know.',
        tab: 'features',
      },
      {
        for: 'Everyone',
        title: 'A calmer rota screen',
        body: 'The sections now sit in a bar across the top, grouped into menus, so the rota has the full width of the screen. Above the rota, the decisions bar lists what needs settling this week, most urgent first, each with the one button that settles it, and folds to a line once read. Simple, Standard and Expert, beside the views, choose how much the screen shows: Simple is the decisions and the timeline, Expert lays every view out at once.',
        tryIt: 'Switch to Simple for a busy service, then fold the decisions bar once you have read it.',
        tab: 'rota',
      },
      {
        for: 'Everyone',
        title: 'A calmer look',
        body: 'Labels read as words instead of small capitals, notices are quiet cards marked by a coloured dot, cards and controls are rounder, and Ask Shifty sits in the bottom right, with Ctrl K opening it from anywhere. Same screens, easier to read on a busy shift.',
      },
    ],
  },
  {
    week: '2026-10-19',
    test: 'Take one site through a full cycle: build the week, publish it, clock two people in on the tablet and one on a phone, approve the hours, send them to payroll and post the accrual. If any step needs an explanation, that is the next thing to fix.',
    steps: [
      {
        for: 'Everyone',
        title: 'This walkthrough',
        body: 'Every Monday the new features open here, in the live app and the demo alike, each one on the screen it changed. You only see what your role is offered. What\'s new, at the right of the bar at the top of the screen, brings it back, and past weeks stay in the list.',
      },
      {
        for: 'Everyone',
        title: 'Go to',
        body: 'Type part of a section\'s name into Go to, in the bar at the top of the screen, or press / from anywhere, and Enter opens the best match. Nobody needs to know which group a section lives in.',
        tryIt: 'Press / now and type "cash".',
      },
      {
        for: 'GMs',
        title: 'Six new ways to see the week',
        body: 'Beside Service timeline and By person: Cover map, Rest, Positions, Shift cost, Changes and Fairness. Each answers one decision the grid leaves to the eye: where to add or cut the next hour, who is being worn down, which shift to cut when labour runs over.',
        tryIt: 'Open Changes, move one shift and watch who the next publish would tell.',
        tab: 'rota',
        lens: 'changes',
      },
      {
        for: 'GMs',
        title: 'Staff requests',
        body: 'Every request waiting, each with what it would do now: rules broken, clashes, who else is off, holiday left after it. Open shifts go to everyone eligible, and a sick person\'s shift goes out for cover in one click, checked by the same compliance engine as the rota.',
        tab: 'requests',
      },
      {
        for: 'GMs',
        title: 'Wellbeing',
        body: 'Who needs a conversation this week and why: long weeks, close then open, no weekend off in four, missed breaks, no holiday in three months. None of these breaks the law, which is why compliance lets them through. They are what drives people out.',
        tab: 'welfare',
      },
      {
        for: 'GMs',
        title: 'Onboarding',
        body: 'One checklist for every person starting in the next 60 days or who started in the last 90. Right to work and pay before any shift, the rest by day one, week one and month one. Late steps go red and open the form that fixes them.',
        tab: 'onboarding',
      },
      {
        for: 'Operators',
        title: 'Staff app adoption',
        body: 'Per site: the share of the team on the app, notifications on, requests decided within a day, open shifts filled and no-shows. It shows whether each GM runs the team through the app or round it. Every red cell is a conversation with a GM.',
        tab: 'adoption',
      },
      {
        for: 'Finance',
        title: 'Labour cash',
        body: 'What each company pays out for its people over the next 13 weeks, and when: net pay on each pay day, PAYE and NI to HMRC by the 22nd, pensions after deduction. The accrual says what labour cost; this says when the bank account feels it.',
        tab: 'cash',
      },
      {
        for: 'Finance',
        title: 'Pay premiums',
        body: 'Each company sets the enhanced rates its contracts pay: Sundays, bank holidays, night hours and overtime, as a multiple or a fixed amount on top. The rota, the P&L, the accrual and TeamPay all cost them the same way, so payroll pays what was accrued.',
        tab: 'pay',
      },
      {
        for: 'Staff',
        title: 'A drawn rota in the staff app',
        body: 'Staff see the next two weeks as a strip with hours, pay before tax, shortest rest and days off, each shift beside the people on with them, and every open shift tagged with what it does to their week. They only ask for a shift once they know what it costs them.',
      },
    ],
  },
];

/** Releases already out on the day given, newest first. */
export function releasesOut(today: string, releases: Release[] = RELEASES): Release[] {
  return releases.filter((r) => r.week <= today).sort((a, b) => b.week.localeCompare(a.week));
}

/** This week's release: the newest one out. */
export function currentRelease(today: string, releases: Release[] = RELEASES): Release | null {
  return releasesOut(today, releases)[0] ?? null;
}

/** The steps this person is offered, in order. `offeredTab` says whether they are offered a section. */
export function stepsFor(release: Release, offeredTab: (tab: Tab) => boolean): WalkStep[] {
  return release.steps.filter((s) => !s.tab || offeredTab(s.tab));
}

/** What a release is called on screen. */
export function releaseLabel(week: string): string {
  const d = new Date(`${week}T12:00:00Z`);
  return `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`;
}

// The last release each person has seen, kept in the browser. A demo sandbox is new every visit but
// the browser is not, so a returning visitor is not walked through the same week twice.
const SEEN_KEY = 'preshift.whatsnew.seen';

export function seenWeek(who: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>;
    return all[who] ?? null;
  } catch {
    return null;
  }
}

export function markSeen(who: string, week: string) {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>;
    all[who] = week;
    localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {
    // Private mode: the walkthrough is offered again next visit, which does no harm.
  }
}

// A browser can be told not to pop the week's changes up by themselves: a screen shared by a team,
// a demo being presented, or the browser checks. What's new in the bar still opens them.
const AUTO_KEY = 'preshift.whatsnew.auto';

/** Whether the week's changes pop up by themselves at the first sign-in of the week in this browser. */
export function popsUp(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Whether a week is a Monday, as every release must start on one. */
export function isMonday(week: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(week) && weekStart(week) === week;
}
