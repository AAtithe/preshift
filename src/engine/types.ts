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
  /** Where the site is, for its weather and nearby events. Falls back to the geofence centre. */
  location?: { lat: number; lng: number };
}

/** A circle round the site's front door. */
export interface GeoFence {
  lat: number;
  lng: number;
  radiusMetres: number;
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
  /**
   * What the baseline model said, kept when someone overrides it, so each
   * override can be scored against what actually happened.
   */
  modelSales?: number;
  modelCovers?: number;
  /** Who last changed the figure away from the model, and why. */
  overriddenBy?: string;
  overrideReason?: string;
}

/** What one trading hour actually took, from the till. The forecast model learns from these. */
export interface HourActual {
  siteId: string;
  date: string;
  hour: number; // 0-23
  sales: number; // net of VAT
  covers: number;
}

export type AdjustmentReason = 'weather' | 'event' | 'bank_holiday' | 'closure' | 'other';

/**
 * A known one-off that moves a day's trade: a heatwave, a match at the stadium
 * down the road, a closure. Applied to the model as a multiplier on the day, or
 * on a span of hours when only part of the day is affected.
 */
export interface ForecastAdjustment {
  id: string;
  siteId: string;
  date: string;
  /** 1.15 is fifteen per cent busier, 0 is closed. */
  factor: number;
  reason: AdjustmentReason;
  note?: string;
  fromHour?: number;
  toHour?: number;
  /**
   * Set when the model added it itself: 'auto' from history (occasions, events, weather), 'bookings'
   * from covers already on the books. People's adjustments have none.
   */
  source?: 'auto' | 'bookings';
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
  /** How a clock was made: a card tapped on a site reader, or a person signing in on a device. */
  method?: 'card' | 'device';
  clockInLocation?: ClockLocation;
  clockOutLocation?: ClockLocation;
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
  /** Till actuals by hour. Absent on organisations saved before forecasting learnt from history. */
  actuals?: HourActual[];
  forecastAdjustments?: ForecastAdjustment[];
  /** Daily weather per site: observed for days gone, forecast for days ahead. */
  weather?: DailyWeather[];
  /** Things on near a site: matches, concerts, markets. From feeds or entered by hand. */
  localEvents?: LocalEvent[];
  /** Table bookings for days still to come, and the last day or two. No guest details are ever kept. */
  bookings?: Booking[];
  /** How past days filled up: covers on the books at set lead times, kept once the bookings themselves are gone. */
  bookingPace?: BookingPace[];
}

export type BookingStatus = 'booked' | 'cancelled' | 'no_show' | 'completed';

/**
 * One table booking, as the booking system reports it, reduced to what the
 * forecast needs: when, how many, and when it was made or cancelled. Names,
 * phone numbers, emails and notes are never accepted or stored.
 */
export interface Booking {
  /** The booking system's own reference, prefixed with its source. */
  id: string;
  siteId: string;
  source: string;
  date: string;
  startMinute: number;
  covers: number;
  status: BookingStatus;
  /** When the booking was made. Without it, a booking counts only on the day itself. */
  createdAt?: string;
  /** When it was cancelled, for a cancelled booking. */
  cancelledAt?: string;
}

/** Covers on the books for one site, date and daypart at each of PACE_LEADS days before. */
export interface BookingPace {
  siteId: string;
  date: string;
  daypart: string;
  booked: number[];
  /** The lead times `booked` is read at, kept with the row so changing them later never misreads old rows. */
  leads?: number[];
}

export interface DailyWeather {
  siteId: string;
  date: string;
  tempMax: number;
  tempMin: number;
  precipitationMm: number;
  /** WMO weather code, as Open-Meteo reports it. */
  weatherCode?: number;
  /** True once the day has happened and the figures are what was measured. */
  observed: boolean;
  fetchedAt: string;
}

export interface LocalEvent {
  id: string;
  siteId: string;
  /** The feed it came from. Absent for events entered by hand. */
  feedId?: string;
  date: string;
  /** Local start time in minutes, when known. */
  startMinute?: number;
  name: string;
  venue?: string;
  source: 'ics' | 'ticketmaster' | 'manual';
}
