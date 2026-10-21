// Core domain model. Times are minutes from midnight on the shift's date;
// an end time past 1440 means the shift runs over midnight.

export type Department = 'FOH' | 'BOH' | 'BAR' | 'MGMT';

export interface Role {
  id: string;
  name: string;
  department: Department;
  /** Nominal ledger code the role's wages post to. */
  nominalCode: string;
}

export interface Site {
  id: string;
  name: string;
  /** Labour cost as a share of net sales the site is held to, e.g. 0.28. */
  labourTargetPct: number;
  /** Tracking category used in the accounting journal. */
  trackingCode: string;
  openMinute: number;
  closeMinute: number;
}

export type PayBasis = 'hourly' | 'salaried';

export interface Availability {
  /** 0 = Monday ... 6 = Sunday */
  weekday: number;
  fromMinute: number;
  toMinute: number;
}

export interface Employee {
  id: string;
  name: string;
  siteId: string;
  /** Roles this person is trained for; the first is their primary role. */
  roleIds: string[];
  payBasis: PayBasis;
  /** Hourly rate for hourly staff. */
  hourlyRate: number;
  /** Annual salary for salaried staff. */
  annualSalary: number;
  dateOfBirth: string; // ISO date
  contractedHours: number;
  maxWeeklyHours: number;
  optedOutOf48: boolean;
  /** Irregular hours or part year: holiday accrues at 12.07% of hours worked. */
  irregularHours: boolean;
  pensionEnrolled: boolean;
  availability: Availability[];
  /** ISO dates the person is on approved leave. */
  leave: string[];
  /** The person's employee id in the payroll system (TeamPay). Set once synced. */
  payrollId?: string;
  status?: 'active' | 'leaver';
  leaveDate?: string;
}

export interface Shift {
  id: string;
  employeeId: string;
  roleId: string;
  siteId: string;
  date: string; // ISO date
  startMinute: number;
  endMinute: number;
  /** Unpaid break in minutes. */
  breakMinutes: number;
  published?: boolean;
}

/** Forecast for one trading hour at one site. */
export interface HourForecast {
  siteId: string;
  date: string;
  hour: number; // 0-23
  sales: number; // net of VAT
  covers: number;
}

/** How a role's demand is driven by the forecast. */
export interface DemandRule {
  roleId: string;
  siteId: string;
  /** Net sales one person in this role can carry per hour. */
  salesPerLabourHour?: number;
  /** Covers one person in this role can serve per hour. */
  coversPerHour?: number;
  /** Headcount floor whenever the site is open. */
  minimumWhileOpen: number;
  maximum: number;
}

export type TimeEntryStatus = 'open' | 'submitted' | 'approved' | 'rejected';

/** Actual time worked, from clocking or a manager's manual entry. Payroll is paid from these, not the rota. */
export interface TimeEntry {
  id: string;
  employeeId: string;
  siteId: string;
  roleId: string;
  shiftId?: string;
  date: string;
  clockIn: number; // minutes from midnight on `date`
  clockOut?: number;
  breakMinutes: number;
  status: TimeEntryStatus;
  source: 'clock' | 'manual';
  approvedBy?: string;
  approvedAt?: string;
}

export interface RotaState {
  sites: Site[];
  roles: Role[];
  employees: Employee[];
  shifts: Shift[];
  forecast: HourForecast[];
  demandRules: DemandRule[];
}
