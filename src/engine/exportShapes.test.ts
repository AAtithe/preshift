import { describe, expect, it } from 'vitest';
import { importPeople, importShifts } from './externalImport';
import { importAbsences, importHours, importTraining } from './hrImport';
import type { Employee, RotaState } from './types';

// Exports as rota, HR and payroll systems tend to produce them: a title and date range above the headers,
// a totals row at the bottom, "Surname, First" names, split name columns, a byte order mark, semicolons
// for commas, 12 hour times, and units in the headers. These are shapes, not any one vendor's layout:
// real files from customers' old systems are still to be run through before they are relied on.

const TODAY = '2026-11-06';
const people = [
  { id: 'e1', name: 'Pat Lee', siteId: 'ck', roleIds: ['server'], leave: [], contractedHours: 40, email: 'pat@x.example' },
  { id: 'e2', name: "Siobhán O'Neill", siteId: 'ck', roleIds: ['chef'], leave: [], contractedHours: 0 },
] as unknown as Employee[];
const state = {
  employees: people, shifts: [],
  sites: [{ id: 'ck', name: 'Clerkenwell' }], roles: [{ id: 'server', name: 'Server' }, { id: 'chef', name: 'Chef' }],
} as unknown as RotaState;

describe('export shapes', () => {
  it('a timesheet with a title, a date range, 12 hour times, units in headers and a totals row', () => {
    const csv = [
      '﻿Timesheet report',
      'Period: 05/10/2026 - 11/10/2026',
      '',
      'Employee,Location,Date,Clock In,Clock Out,Unpaid Break (mins),Paid Hours (h)',
      '"Lee, Pat",Clerkenwell,05/10/2026,9:00 AM,5:30 PM,30,8',
      "\"O'Neill, Siobhán\",Clerkenwell,06/10/2026,6:00 PM,1:00 AM,0,7",
      'Total,,,,,,15',
    ].join('\r\n');
    const r = importHours(csv, state, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.unknownPeople).toEqual([]);
    expect(r.entries.map((e) => [e.employeeId, e.date, e.clockIn, e.clockOut])).toEqual([['e1', '2026-10-05', 540, 1050], ['e2', '2026-10-06', 1080, 1500]]);
  });

  it('a European style export with semicolons and split names', () => {
    const csv = ['First Name;Last Name;Position;Pay Rate;Birth Date;Hire Date', 'Dana;Kerr;Server;12,71;30/06/1990;02/09/2021'].join('\n');
    const r = importPeople(csv, state, { today: TODAY });
    expect(r.errors).toEqual([]);
    expect(r.people[0].person).toMatchObject({ name: 'Dana Kerr', roleIds: ['server'], dateOfBirth: '1990-06-30', payBasis: 'hourly', hourlyRate: 12.71 });
  });

  it('a schedule export with dates and times in one cell, and a totals row', () => {
    const csv = ['Schedule 09/11/2026 to 15/11/2026', 'Team Member,Shift Start,Shift End,Position,Site', 'Pat Lee,09/11/2026 17:00,10/11/2026 01:00,Server,Clerkenwell', 'Totals,,,,'].join('\n');
    const r = importShifts(csv, state, {});
    expect(r.errors).toEqual([]);
    expect(r.unknownPeople).toEqual([]);
    expect(r.shifts[0]).toMatchObject({ date: '2026-11-09', startMinute: 1020, endMinute: 1500 });
  });

  it('an HR absence report with names by email, and a training matrix with unusual course names', () => {
    const absences = importAbsences(['Absence report', 'Email,Category,From,To,Working days', 'pat@x.example,Sickness - Cold/Flu,01/10/2026,03/10/2026,3', 'Grand total,,,,3'].join('\n'), state, TODAY);
    expect(absences.errors).toEqual([]);
    expect(absences.unknownPeople).toEqual([]);
    expect(absences.absences[0].absence).toMatchObject({ type: 'sickness', from: '2026-10-01', to: '2026-10-03' });
    const training = importTraining(['Employee,Qualification,Achieved,Valid Until', "Siobhán O'Neill,CIEH Level 2 Award in Food Safety in Catering,01/02/2025,01/02/2028"].join('\n'), state, [], TODAY);
    expect(training.records[0].record).toMatchObject({ title: 'Food hygiene level 2', expiresOn: '2028-02-01' });
  });
});

describe('numbers as exports write them', () => {
  it('reads decimal commas and thousands separators both ways', async () => {
    const { numberOf } = await import('./externalImport');
    expect(['7,5', '1.234,56', '1,234.56', '£12.71', '(15.00)', '38,000', ''].map(numberOf)).toEqual([7.5, 1234.56, 1234.56, 12.71, -15, 38000, NaN]);
  });

  it('reads 7,5 hours as seven and a half, not seventy-five', () => {
    const r = importHours(['Name;Date;Hours', 'Pat Lee;01/10/2026;7,5'].join('\n'), state, TODAY);
    expect(r.hoursTotal).toBe(7.5);
  });
});
