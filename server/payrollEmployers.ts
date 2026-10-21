import type { Entity } from '../src/engine/types';
import { PayrollError } from './integrations/payroll/provider';
import type { OrgData } from './store';

/** How the payroll employer for each company is found. */
export interface EmployerConfig {
  /** `TEAMPAY_EMPLOYER_ID`: only ever used by an organisation with a single company. */
  defaultEmployerId?: string;
  /** The simulator gives every company its own employer, so demos behave like a real group. */
  simulated: boolean;
}

export interface EmployerStatus {
  entityId: string;
  name: string;
  payeReference: string;
  employerId: string | null;
  /** Why there is no employer, when there is none. */
  problem: string | null;
}

/**
 * The payroll employer (PAYE scheme) a company's people are paid through.
 * A company's own setting wins. The organisation-wide default applies only
 * when there is one company, because sending a second company's people or
 * hours to it would put them on the wrong PAYE scheme.
 */
export function employerStatus(org: OrgData, entity: Entity, config: EmployerConfig): EmployerStatus {
  const base = { entityId: entity.id, name: entity.name, payeReference: entity.payeReference };
  if (entity.payrollEmployerId) return { ...base, employerId: entity.payrollEmployerId, problem: null };
  if (config.simulated) return { ...base, employerId: `sim_er_${entity.id}`, problem: null };
  if (org.state.entities.length <= 1 && config.defaultEmployerId) return { ...base, employerId: config.defaultEmployerId, problem: null };
  return {
    ...base,
    employerId: null,
    problem:
      org.state.entities.length > 1
        ? `${entity.name} has no TeamPay employer set. Each company in a group runs its own PAYE scheme, so it needs its own.`
        : `${entity.name} has no TeamPay employer set.`,
  };
}

/** The employer for a company, or a payroll error that will not succeed on retry until someone sets it. */
export function employerFor(org: OrgData, entityId: string, config: EmployerConfig): string {
  const entity = org.state.entities.find((e) => e.id === entityId);
  if (!entity) throw new PayrollError(`Company ${entityId} not found`, false);
  const status = employerStatus(org, entity, config);
  if (!status.employerId) throw new PayrollError(status.problem!, false);
  return status.employerId;
}
