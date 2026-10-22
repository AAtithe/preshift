import { describe, expect, it } from 'vitest';
import { adoptPayroll, candidates, differences, matchLevel, normaliseName, type PayrollPerson } from './payrollMatch';
import { seedState } from './seed';

const person = { ...seedState('2026-10-21').employees.find((e) => e.id === 'mar-2')! }; // Marco Bianchi, chef, £16.50, 40h
const record = (over: Partial<PayrollPerson> = {}): PayrollPerson => ({
  payrollId: 'tp_1', name: person.name, dateOfBirth: person.dateOfBirth, payBasis: 'hourly', hourlyRate: person.hourlyRate, contractedHours: person.contractedHours, ...over,
});

describe('matching people to payroll records', () => {
  it('ignores case, accents, punctuation and titles in names', () => {
    expect(normaliseName("Mr. José  O'Neil-Smith")).toBe('jose oneilsmith');
  });

  it('grades a match by name and date of birth', () => {
    expect(matchLevel(person, record())).toBe('exact');
    expect(matchLevel(person, record({ name: 'MARCO BIANCHI' }))).toBe('exact');
    expect(matchLevel(person, record({ name: 'Marcello Bianchi' }))).toBe('likely');
    expect(matchLevel(person, record({ dateOfBirth: undefined }))).toBe('likely');
    expect(matchLevel(person, record({ dateOfBirth: '1991-07-02' }))).toBe('name');
    expect(matchLevel(person, record({ name: 'Aisha Okafor', dateOfBirth: '1995-11-20' }))).toBeNull();
  });

  it('never offers a record linked to someone else or a leaver, and puts the best first', () => {
    const records = [record({ payrollId: 'a', name: 'Marcello Bianchi' }), record({ payrollId: 'b' }), record({ payrollId: 'c' }), record({ payrollId: 'd', leaveDate: '2025-01-31' })];
    expect(candidates(person, records, new Set(['c'])).map((m) => [m.record.payrollId, m.level])).toEqual([['b', 'exact'], ['a', 'likely']]);
  });

  it('compares only what payroll holds, and pay on the right basis', () => {
    expect(differences(person, record())).toEqual([]);
    expect(differences(person, record({ hourlyRate: 15.5, contractedHours: undefined })).map((d) => [d.field, d.pay])).toEqual([['hourlyRate', true]]);
    const salaried = differences(person, record({ payBasis: 'salaried', annualSalary: 34000, hourlyRate: undefined }));
    expect(salaried.map((d) => d.field)).toEqual(['payBasis']);
  });

  it("takes payroll's values for each difference", () => {
    const r = record({ name: 'Marco A. Bianchi', hourlyRate: 15.5, contractedHours: 0 });
    const next = adoptPayroll(person, differences(person, r), r);
    expect(next).toMatchObject({ name: 'Marco A. Bianchi', hourlyRate: 15.5, contractedHours: 0, irregularHours: true });
  });

  it('never touches pay when only other fields are taken', () => {
    const r = record({ name: 'Marco A. Bianchi', hourlyRate: 15.5 });
    const nameOnly = differences(person, r).filter((d) => !d.pay);
    expect(adoptPayroll(person, nameOnly, r).hourlyRate).toBe(person.hourlyRate);
  });

  it('brings the pay figure across when the basis itself changes', () => {
    const r = record({ payBasis: 'salaried', annualSalary: 34000, hourlyRate: undefined });
    expect(adoptPayroll(person, differences(person, r), r)).toMatchObject({ payBasis: 'salaried', annualSalary: 34000 });
  });
});
