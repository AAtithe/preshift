import { describe, expect, it } from 'vitest';
import { absenceTypeOf, contractTypeOf, courseOf, importAbsences, importDocuments, importRightToWork, importToil, importTraining, NI_NUMBER } from './hrImport';
import type { Employee, HrRecord } from './types';

// The personnel side of moving across: absences, TOIL, the HR file, training and right to work.

const TODAY = '2026-11-04';
const person = (id: string, name: string, extra: Partial<Employee> = {}) => ({ id, name, siteId: 'ck', roleIds: ['chef'], leave: [], contractedHours: 40, ...extra }) as unknown as Employee;
const pat = person('e1', 'Pat Lee', { email: 'pat@x.example' });
const jo = person('e2', 'Jo Ray', { contractedHours: 0, absences: [{ id: 'a1', type: 'sickness', from: '2026-09-01', to: '2026-09-02' }] });
const sam = person('e3', 'Sam Cook', { rightToWork: { checked: true, checkedOn: '2026-10-01', documents: [{ id: 'd' } as never] }, toil: [{ id: 't', kind: 'opening', date: '2026-10-01', hours: 4, by: 'x', at: 'x' }] });
const state = { employees: [pat, jo, sam] };
const csv = (...rows: string[]) => rows.join('\n');

describe('absences', () => {
  it('reads sickness and other absence, sends future holiday to leave, and leaves TOIL and past holiday alone', () => {
    const r = importAbsences(csv(
      'Employee,Absence Type,Start Date,End Date,Reason,Fit Note,Return to Work',
      'Pat Lee,Sickness,01/10/2026,12/10/2026,Flu,No,13/10/2026',
      'Pat Lee,Annual Leave,03/11/2026,06/11/2026,,,',
      'Pat Lee,Annual Leave,01/08/2026,02/08/2026,,,',
      'Jo Ray,Sickness,01/09/2026,02/09/2026,,,',
      'Jo Ray,Bereavement,15/10/2026,,,,',
      'Jo Ray,TOIL,20/10/2026,,,,',
      'Jo Ray,Jury service,22/10/2026,ongoing,,,',
      'Nobody,Sickness,01/10/2026,,,,',
    ), state, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.absences.map((a) => a.absence)).toEqual([
      { type: 'sickness', from: '2026-10-01', to: '2026-10-12', reason: 'Flu', fitNote: false, returnToWorkOn: '2026-10-13' },
      { type: 'compassionate', from: '2026-10-15', to: '2026-10-15' },
      { type: 'other', from: '2026-10-22', reason: 'Jury service' },
    ]);
    expect(r.leave).toEqual([{ employeeId: 'e1', name: 'Pat Lee', dates: ['2026-11-04', '2026-11-05', '2026-11-06'] }]);
    expect(r).toMatchObject({ pastHoliday: 2, toilRows: 1, duplicates: 1, fitNotesMissing: 1, assumedSickness: false });
    expect(r.unknownPeople).toEqual([{ name: 'Nobody', rows: 1 }]);
  });

  it('reads a sickness log with no type column as sickness, and days lost as calendar days', () => {
    const r = importAbsences(csv('Name,Date,Days lost', 'Pat Lee,02/11/2026,3'), state, TODAY);
    expect(r.assumedSickness).toBe(true);
    expect(r.absences[0].absence).toEqual({ type: 'sickness', from: '2026-11-02', to: '2026-11-04' });
  });

  it('maps the words old systems use', () => {
    expect(['SSP', 'Maternity leave', 'AWOL', 'Childcare emergency', 'Unpaid leave', 'Holiday', 'Time off in lieu', ''].map(absenceTypeOf)).toEqual(['sickness', 'family', 'unauthorised', 'dependants', 'unpaid', 'holiday', 'toil', null]);
  });
});

describe('TOIL', () => {
  it('opens a balance per person, from the balance or earned less taken, and never twice', () => {
    const r = importToil(csv('Name,TOIL earned,TOIL taken,As at', 'Pat Lee,10,4,31/10/2026', 'Jo Ray,2,5,', 'Sam Cook,3,0,'), state, TODAY);
    expect(r.rows).toEqual([{ line: 2, employeeId: 'e1', name: 'Pat Lee', date: '2026-10-31', hours: 6 }]);
    expect(r.errors[0]).toMatch(/Jo Ray\): a negative TOIL balance/);
    expect(r.existing).toEqual(['Sam Cook']);
  });

  it('turns days into hours on the contracted day', () => {
    const r = importToil(csv('Name,TOIL balance (days)', 'Pat Lee,1.5', 'Jo Ray,1'), state, TODAY);
    expect(r.inDays).toBe(true);
    expect(r.rows[0].hours).toBe(12);
    expect(r.errors[0]).toMatch(/no contracted hours/);
  });
});

describe('documents and the HR file', () => {
  it('fills the HR file over what is there, checks NI numbers, and records documents with their dates', () => {
    const withFile = { employees: [{ ...pat, hr: { jobTitle: 'Chef de partie', postcode: 'EC1 1AA' } }, jo, sam] };
    const records: HrRecord[] = [];
    const r = importDocuments(csv(
      'Name,Contract Type,Written Statement Issued,Written Statement Signed,Probation End,NI Number,Emergency Contact,Emergency Phone,Line Manager,Document,Document Date',
      'Pat Lee,Zero hours,01/09/2026,03/09/2026,01/12/2026,ab 12 34 56 c,Alex Lee,07700900000,Sam Cook,Uniform policy,03/09/2026',
      'Jo Ray,Permanent,,,,AB123,,,Nobody Here,,',
    ), withFile, records);
    expect(r.errors).toEqual([]);
    expect(r.profiles[0].profile).toEqual({
      jobTitle: 'Chef de partie', postcode: 'EC1 1AA', contractType: 'casual', contractIssuedOn: '2026-09-01', contractSignedOn: '2026-09-03', probationEnd: '2026-12-01',
      niNumber: 'AB123456C', emergencyContact: { name: 'Alex Lee', phone: '07700900000' }, managerId: 'e3',
    });
    expect(r.profiles[1].notes.join(' ')).toMatch(/NI number is not in a valid format.*Line manager "Nobody Here"/);
    expect(r.documents).toEqual([{ line: 2, employeeId: 'e1', name: 'Pat Lee', record: { employeeId: 'e1', kind: 'document', date: '2026-09-03', title: 'Uniform policy' } }]);
    expect(r.copiesNeeded).toBe(1);
  });

  it('knows contract types and NI numbers', () => {
    expect(['Full time', 'Seasonal', 'Bank staff', 'Apprenticeship', 'Odd'].map(contractTypeOf)).toEqual(['permanent', 'fixed-term', 'casual', 'apprentice', null]);
    expect(['AB123456C', 'JG103759A', 'QQ123456C', 'DA123456A', 'GB123456A', 'AB123456E'].map((n) => NI_NUMBER.test(n))).toEqual([true, true, false, false, false, false]);
  });
});

describe('training', () => {
  it('matches certificates to the courses an inspector asks for, suggests expiry, and skips what is on file', () => {
    const onFile = [{ employeeId: 'e1', kind: 'training' as const, title: 'Allergen awareness', date: '2025-01-10' }];
    const r = importTraining(csv(
      'Employee,Course,Completed,Expiry',
      'Pat Lee,Level 2 Food Safety and Hygiene for Catering,12/03/2024,',
      'Pat Lee,Allergy awareness,10/01/2025,',
      'Pat Lee,Wine Level 1,01/06/2025,none',
      'Jo Ray,Challenge 25,01/09/2025,01/09/2026',
    ), state, onFile, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.records.map((x) => [x.record.title, x.record.expiresOn, x.suggestedExpiry])).toEqual([
      ['Food hygiene level 2', '2027-03-12', true],
      ['Wine Level 1', undefined, false],
      ['Licensing and Challenge 25', '2026-09-01', false],
    ]);
    expect(r).toMatchObject({ duplicates: 1, expired: 1, otherCourses: [{ name: 'Wine Level 1', rows: 1 }] });
    expect(courseOf('Personal Licence Holder (APLH)').title).toBe('Personal licence');
  });
});

describe('right to work', () => {
  it('records checks with their date and evidence, keeps a newer check, and counts copies still needed', () => {
    const r = importRightToWork(csv(
      'Name,Date Checked,Document Type,Visa Expiry,Term Time Hour Limit',
      'Pat Lee,15/08/2026,Share code,20/12/2026,20',
      'Jo Ray,01/02/2024,British passport,N/A,',
      'Sam Cook,01/09/2026,BRP,,',
    ), state, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.checks.map((c) => c.rightToWork)).toEqual([
      { checked: true, checkedOn: '2026-08-15', evidence: 'Share code', expiry: '2026-12-20', studentWeeklyHourLimit: 20 },
      { checked: true, checkedOn: '2024-02-01', evidence: 'British passport' },
    ]);
    expect(r.checks[0].notes[0]).toMatch(/expires on 2026-12-20: book the follow-up check/);
    expect(r).toMatchObject({ newerOnFile: ['Sam Cook'], copiesNeeded: 2, expired: 0 });
  });

  it('refuses a check with no date, or dated in the future', () => {
    const r = importRightToWork(csv('Name,Checked on', 'Pat Lee,', 'Jo Ray,01/01/2027'), state, TODAY);
    expect(r.checks).toEqual([]);
    expect(r.errors).toHaveLength(2);
  });
});
