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

/**
 * A legal entity: one company, one PAYE scheme, one ledger. Sites trade in an
 * entity and people are employed by one, which need not be the entity whose
 * site they work at. Groups often run a central employing company.
 */
export interface Entity {
  id: string;
  name: string;
  companyNumber: string;
  /** Employer PAYE reference. On-costs are worked per employment, so per scheme. */
  payeReference: string;
  /**
   * Balance sheet code every ledger in the group uses for balances with this
   * entity, so both sides of an intercompany recharge reconcile code for code.
   */
  intercompanyCode: string;
  /**
   * Set on the one company in a connected group that claims Employment
   * Allowance. `remaining` is what the last payroll left unused, and `asAt` is
   * the last day that payroll covered (the end of a pay week).
   */
  employmentAllowance?: { remaining: number; asAt: string };
}

export interface Site {
  id: string;
  name: string;
  /** The entity whose books this site trades in. */
  entityId: string;
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

/** Home Office right to work check. Without one on file the employer has no statutory excuse. */
export interface RightToWork {
  checked: boolean;
  /** ISO date the check was done. */
  checkedOn?: string;
  /** Evidence seen, e.g. 'British passport', 'Share code'. */
  evidence?: string;
  /** Time-limited permission: a follow-up check is due before this date. */
  expiry?: string;
}

export interface Employee {
  id: string;
  name: string;
  /** Home site: where the person is normally rostered and where unrostered pay is charged. */
  siteId: string;
  /** The employing entity, whose PAYE scheme pays them. */
  entityId: string;
  /** Other sites the person is willing and trained to cover. */
  coverSiteIds: string[];
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
  email?: string;
  phone?: string;
  /** First day of employment. Absent means employed before records began. */
  startDate?: string;
  rightToWork?: RightToWork;
  /** The person's employee id in the payroll system (TeamPay). Set once synced. */
  payrollId?: string;
  status?: 'active' | 'leaver';
  /** Last day of employment for a leaver. */
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
  entities: Entity[];
  sites: Site[];
  roles: Role[];
  employees: Employee[];
  shifts: Shift[];
  forecast: HourForecast[];
  demandRules: DemandRule[];
}
