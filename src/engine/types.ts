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
  /** Where staff must be to clock in. */
  location?: GeoPoint;
  /** Clock-in radius around `location`, in metres. */
  geofenceMetres?: number;
  /** What kind of site this is, for choosing benchmark peers. */
  concept?: Concept;
  region?: string;
}

export type Concept = 'restaurant' | 'bar' | 'pub' | 'cafe';

export interface GeoPoint {
  lat: number;
  lng: number;
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
  rightToWork?: RightToWork;
  /** How often the person is paid, which sets the minimum wage pay reference period. Weekly if absent. */
  payFrequency?: 'weekly' | 'monthly';
  /**
   * Weekly deductions and payments that reduce pay for minimum wage purposes:
   * uniform or tools the worker pays for, salary sacrifice, and similar.
   */
  nmwReducingDeductionsWeekly?: number;
}

/** The right to work check on file and any conditions on the person's permission. */
export interface RightToWork {
  /** Unlimited covers British and Irish citizens and settled status. */
  basis: 'unlimited' | 'time-limited' | 'student';
  /** Date the check was done. Without one there is no statutory excuse. */
  checkedOn?: string;
  /** Last day of permission for time-limited and student permission. */
  expires?: string;
  /** Student permission: maximum hours in a Monday to Sunday week during term time. */
  weeklyHourLimit?: number;
  /** Student permission: the institution's official vacations, when full-time work is allowed. */
  vacations?: { from: string; to: string }[];
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

/**
 * What actually happened: one clock-in to clock-out. Times use the same
 * minutes-from-midnight convention as shifts, on the date the person clocked in.
 */
export interface ClockRecord {
  id: string;
  employeeId: string;
  siteId: string;
  roleId: string;
  /** The rostered shift this clocking is against; absent when the person was not on the rota. */
  shiftId?: string;
  date: string;
  clockIn: number;
  /** Absent while the person is still on shift. */
  clockOut?: number;
  /** Unpaid break actually taken, in minutes. */
  breakMinutes: number;
  /** A manager has reviewed the difference to the rota and signed it off for payroll. */
  approved?: boolean;
  source: 'geofence' | 'manager';
}

/** Net sales and covers actually taken in one trading hour. */
export interface HourActual {
  siteId: string;
  date: string;
  hour: number;
  sales: number;
  covers: number;
}

/**
 * Tips, gratuities and service charges the business took on the customer's
 * behalf on one day. Under the Employment (Allocation of Tips) Act 2023 all of
 * it belongs to the workers.
 */
export interface TipsTaken {
  id: string;
  siteId: string;
  date: string;
  source: 'service-charge' | 'card-tip' | 'cash-pooled';
  amount: number;
  /** Date the money reached staff through payroll. */
  paidOn?: string;
}

export interface TroncScheme {
  siteId: string;
  /** The person who decides the allocation. */
  troncmaster: string;
  /**
   * The troncmaster decides the allocation without the employer. Only then are
   * the payments free of Class 1 National Insurance.
   */
  independent: boolean;
  /** Points per clocked hour by role. */
  pointsPerHour: Record<string, number>;
  /** Optional split of the pool by department before points are applied. */
  departmentShares?: Partial<Record<Department, number>>;
  serviceCharge: 'none' | 'discretionary' | 'mandatory';
  /** Date the written tipping policy was made available to staff. */
  policyPublishedOn?: string;
  /** Date staff were last consulted on whether the allocation is fair. */
  lastReviewedOn?: string;
}

export interface RotaState {
  sites: Site[];
  roles: Role[];
  employees: Employee[];
  shifts: Shift[];
  forecast: HourForecast[];
  demandRules: DemandRule[];
  clocks: ClockRecord[];
  actuals: HourActual[];
  tips: TipsTaken[];
  troncSchemes: TroncScheme[];
}
