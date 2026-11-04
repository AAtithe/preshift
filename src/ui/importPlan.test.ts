import { describe, expect, it } from 'vitest';
import type { Employee, RotaState } from '../engine/types';
import { IMPORT_KINDS, planImport, type PlanInput } from './importPlan';

// What each import will do, and the calls that carry it out, before anything is saved.

const pat = { id: 'e1', name: 'Pat Lee', siteId: 'ck', entityId: 'co', roleIds: ['chef'], leave: ['2026-12-24'], contractedHours: 40, payBasis: 'hourly', hourlyRate: 13 } as unknown as Employee;
const state = { entities: [{ id: 'co', name: 'Co' }], sites: [{ id: 'ck', name: 'Clerkenwell', entityId: 'co' }], roles: [{ id: 'chef', name: 'Chef' }], employees: [pat], shifts: [] } as unknown as RotaState;
const input = (kind: PlanInput['kind'], rows: string[][]): PlanInput => ({ kind, rows, state, hrRecords: [], today: '2026-11-04', siteId: 'ck', usDates: false, columns: {} });

describe('import plans', () => {
  it('works through the kinds team first and rota last', () => {
    expect(IMPORT_KINDS.map((k) => k.id)).toEqual(['team', 'rtw', 'documents', 'training', 'holiday', 'toil', 'absences', 'rota']);
  });

  it('adds holiday booked ahead to the leave already there', () => {
    const p = planImport(input('absences', [['Name', 'Absence type', 'First day', 'Last day'], ['Pat Lee', 'Annual leave', '10/12/2026', '11/12/2026'], ['Pat Lee', 'Sick', '01/10/2026', '02/10/2026']]));
    expect(p.calls).toEqual([
      { method: 'POST', path: '/v1/employees/e1/absences', body: { type: 'sickness', from: '2026-10-01', to: '2026-10-02' }, label: 'Pat Lee, 1 Oct 2026' },
      { method: 'PATCH', path: '/v1/employees/e1', body: { leave: ['2026-12-10', '2026-12-11', '2026-12-24'] }, label: 'Pat Lee, holiday booked' },
    ]);
  });

  it('records right to work, training and TOIL through their own endpoints', () => {
    expect(planImport(input('rtw', [['Name', 'Date checked'], ['Pat Lee', '01/09/2026']])).calls[0]).toMatchObject({ method: 'PATCH', path: '/v1/employees/e1', body: { rightToWork: { checked: true, checkedOn: '2026-09-01' } } });
    expect(planImport(input('training', [['Name', 'Course', 'Completed'], ['Pat Lee', 'Allergens', '01/09/2026']])).calls[0]).toMatchObject({ method: 'POST', path: '/v1/hr/records', body: { kind: 'training', title: 'Allergen awareness' } });
    expect(planImport(input('toil', [['Name', 'TOIL balance'], ['Pat Lee', '7.5']])).calls[0]).toMatchObject({ method: 'POST', path: '/v1/employees/e1/toil', body: { kind: 'opening', hours: 7.5 } });
    expect(planImport(input('documents', [['Name', 'Contract type'], ['Pat Lee', 'Permanent']])).calls[0]).toMatchObject({ method: 'PUT', path: '/v1/employees/e1/hr', body: { contractType: 'permanent' } });
  });
});
