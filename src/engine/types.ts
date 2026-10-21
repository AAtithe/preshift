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
  /**
   * The TeamPay employer this company's PAYE scheme is set up as. Each scheme
   * runs its own payroll, so starters, hours and pay runs are routed by it.
   */
  payrollEmployerId?: string;
  /** First day of the leave year as MM-DD, set in each contract. Defaults to 01-01. */
  leaveYearStart?: string;
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
  /** Where staff must be to clock in from a phone or tablet. Absent means no location check. */
  geofence?: GeoFence;
  /** Where the site is, for journeys between sites. Set from its postcode. */
  location?: SiteLocation;
  /** Journey times from this site to others, by destination site id. */
  travel?: Record<string, SiteTravel>;
}

export interface SiteLocation {
  lat: number;
  lng: number;
  postcode?: string;
}

/** A journey time between two sites, and where it came from. */
export interface SiteTravel {
  minutes: number;
  /** TfL's journey planner, a straight-line estimate, or set by hand (which a refresh keeps). */
  source: 'tfl' | 'estimate' | 'manual';
  /** The modes the journey uses, as TfL names them. */
  mode?: string;
  checkedAt: string;
}

/** A circle round the site's front door. */
export interface GeoFence {
  lat: number;
  lng: number;
  radiusMetres: number;
}

/** One break, as the person recorded it. */
export interface BreakPeriod {
  start: number;
  end?: number;
}

/** A device's position when someone clocked, as the browser reported it. */
export interface GeoFix {
  lat: number;
  lng: number;
  /** The browser's own estimate of how far out the fix may be, in metres. */
  accuracyMetres: number;
}

/** Where a clock happened, kept on the time entry as evidence for approval and disputes. */
export interface ClockLocation extends GeoFix {
  /** Distance from the site's geofence centre, when the site has one. */
  distanceMetres?: number;
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

/** Holiday position that is not derived from shifts and leave dates. All figures in hours. */
export interface HolidayRecord {
  /** Contractual entitlement in weeks a year, for people on fixed hours. Statutory minimum 5.6. */
  entitlementWeeks?: number;
  /** Untaken leave carried in from the previous leave year. */
  carriedOverHours?: number;
  /** Opening position when records began part way through the leave year. Accrued applies to accrual staff only. */
  openingAccruedHours?: number;
  openingTakenHours?: number;
  /** Hours a leave date counts for, where it is not a normal day. */
  dayHours?: Record<string, number>;
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
  holiday?: HolidayRecord;
  email?: string;
  phone?: string;
  /** First day of employment. Absent means employed before records began. */
  startDate?: string;
  rightToWork?: RightToWork;
  /** The person's employee id in the payroll system (TeamPay). Set once synced. */
  payrollId?: string;
  /** The payroll employer (PAYE scheme) that `payrollId` belongs to. */
  payrollEmployerId?: string;
  status?: 'active' | 'leaver';
  /** Last day of employment for a leaver. */
  leaveDate?: string;
  /** The UID of the RFID card this person taps to clock in and out, normalised by normaliseBadge. */
  badgeId?: string;
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
  /** How a clock was made: a card on a site reader, by name on a site device, or on the person's own phone. */
  method?: 'card' | 'device' | 'phone';
  clockInLocation?: ClockLocation;
  clockOutLocation?: ClockLocation;
  /** Breaks the person recorded themselves, in minutes on `date` like clockOut. The last may still be running. */
  breaks?: BreakPeriod[];
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
