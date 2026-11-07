import { describe, expect, it } from 'vitest';
import type { Employee, RotaState } from '../engine/types';
import { IMPORT_KINDS, planImport, type PlanInput } from './importPlan';

// What each import will do, and the calls that carry it out, before anything is saved.

const pat = { id: 'e1', name: 'Pat Lee', siteId: 'ck', entityId: 'co', roleIds: ['chef'], leave: ['2026-12-24'], contractedHours: 40, payBasis: 'hourly', hourlyRate: 13 } as unknown as Employee;
const state = { entities: [{ id: 'co', name: 'Co' }], sites: [{ id: 'ck', name: 'Clerkenwell', entityId: 'co' }], roles: [{ id: 'chef', name: 'Chef' }], employees: [pat], shifts: [] } as unknown as RotaState;
const input = (kind: PlanInput['kind'], rows: string[][]): PlanInput => ({ kind, rows, state, hrRecords: [], users: [], today: '2026-11-04', siteId: 'ck', usDates: false, columns: {} });

describe('import plans', () => {
  it('works through the kinds team first and rota last', () => {
    expect(IMPORT_KINDS.map((k) => k.id)).toEqual(['team', 'managers', 'rtw', 'documents', 'training', 'reviews', 'holiday', 'toil', 'absences', 'hours', 'takings', 'rota']);
  });

  it('adds holiday booked ahead to the leave already there', () => {
    const p = planImport(input('absences', [['Name', 'Absence type', 'First day', 'Last day'], ['Pat Lee', 'Annual leave', '10/12/2026', '11/12/2026'], ['Pat Lee', 'Sick', '01/10/2026', '02/10/2026']]));
    expect(p.calls.map(({ undo: _u, ...c }) => c)).toEqual([
      { method: 'POST', path: '/v1/employees/e1/absences', body: { type: 'sickness', from: '2026-10-01', to: '2026-10-02' }, label: 'Pat Lee, 1 Oct 2026' },
      { method: 'PATCH', path: '/v1/employees/e1', body: { leave: ['2026-12-10', '2026-12-11', '2026-12-24'] }, label: 'Pat Lee, holiday booked' },
    ]);
    // Undone: the absence the server made is deleted, and leave goes back to what it was.
    expect(p.calls[0].undo({ absence: { id: 'abs_1' } })).toEqual([{ method: 'DELETE', path: '/v1/employees/e1/absences/abs_1' }]);
    expect(p.calls[1].undo(undefined)).toEqual([{ method: 'PATCH', path: '/v1/employees/e1', body: { leave: ['2026-12-24'] } }]);
  });

  it('undoes a person added, TOIL opened and hours imported through the routes made for it', () => {
    const team = planImport(input('team', [['Name', 'Role', 'Rate', 'DOB', 'Clock card'], ['Dana Kerr', 'Chef', '13', '01/01/1990', 'AB12CD']]));
    expect(team.calls[0].undo({ id: 'emp_9' })).toEqual([{ method: 'DELETE', path: '/v1/import/people/emp_9' }]);
    expect(team.calls[0].then?.({ id: 'emp_9' })).toEqual([{ method: 'PUT', path: '/v1/employees/emp_9/badge', body: { badgeId: 'AB12CD' } }]);
    const toil = planImport(input('toil', [['Name', 'TOIL balance'], ['Pat Lee', '7.5']]));
    expect(toil.calls[0].undo(undefined)[0]).toMatchObject({ method: 'POST', body: { kind: 'adjustment', hours: -7.5 } });
    const hours = planImport(input('hours', [['Name', 'Date', 'Clock in', 'Clock out'], ['Pat Lee', '01/10/2026', '09:00', '17:00']]));
    expect(hours.calls[0].undo({ added: ['te_1', 'te_2'] })).toEqual([{ method: 'DELETE', path: '/v1/import/hours/te_1' }, { method: 'DELETE', path: '/v1/import/hours/te_2' }]);
  });

  it('records right to work, training and TOIL through their own endpoints', () => {
    expect(planImport(input('rtw', [['Name', 'Date checked'], ['Pat Lee', '01/09/2026']])).calls[0]).toMatchObject({ method: 'PATCH', path: '/v1/employees/e1', body: { rightToWork: { checked: true, checkedOn: '2026-09-01' } } });
    expect(planImport(input('training', [['Name', 'Course', 'Completed'], ['Pat Lee', 'Allergens', '01/09/2026']])).calls[0]).toMatchObject({ method: 'POST', path: '/v1/hr/records', body: { kind: 'training', title: 'Allergen awareness' } });
    expect(planImport(input('toil', [['Name', 'TOIL balance'], ['Pat Lee', '7.5']])).calls[0]).toMatchObject({ method: 'POST', path: '/v1/employees/e1/toil', body: { kind: 'opening', hours: 7.5 } });
    expect(planImport(input('documents', [['Name', 'Contract type'], ['Pat Lee', 'Permanent']])).calls[0]).toMatchObject({ method: 'PUT', path: '/v1/employees/e1/hr', body: { contractType: 'permanent' } });
  });
});
