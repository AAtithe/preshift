import type { ShiftOffer } from './cover';

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
  /**
   * What this company pays for travel between sites within a working day. Unset means nobody has
   * chosen yet: it is paid at the normal rate meanwhile, and set-up asks for a choice.
   */
  travelPay?: TravelPay;
}

/**
 * The hourly rate for travel between sites: each person's normal rate, the minimum wage for their
 * age, or a fixed rate. Travel is working time for the minimum wage, so a fixed rate is lifted to
 * it on every hour, unless the company opts to average over the pay period instead.
 */
export type TravelPay =
  | { basis: 'normal' }
  | { basis: 'minimum' }
  /**
   * `averaging` lets the rate sit below the minimum wage, as the law allows, as long as the pay
   * period's total pay over work and travel averages at least the minimum wage; any shortfall is
   * topped up on the travel pay.
   */
  | { basis: 'fixed'; hourly: number; averaging?: boolean };

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
  /** The EPOS location whose takings are this site's, once the till is connected. */
  eposLocationId?: string;
  /** Where staff must be to clock in from a phone or tablet. Absent means no location check. */
  geofence?: GeoFence;
  /** Signing in by name on the site's kiosk needs the person's PIN. Off unless a manager turns it on. */
  kioskPinRequired?: boolean;
  /** Which nation's school calendar applies. England when absent; only England and Wales get an estimate. */
  nation?: 'england' | 'wales' | 'scotland' | 'northern_ireland';
  /** A typical trading week, used to forecast any week no sales system has sent figures for. */
  salesProfile?: SalesProfile;
  /** Cost of sales as a share of food and of drink sales the site is held to, for prime cost. */
  foodCostTargetPct?: number;
  drinkCostTargetPct?: number;
  /** Where the site is, for journeys between sites, its weather and nearby events. Set from its postcode. */
  location?: SiteLocation;
  /** Journey times from this site to others, by destination site id. */
  travel?: Record<string, SiteTravel>;
}

export interface SalesProfile {
  /** Net sales by weekday, Monday first. */
  dailySales: number[];
  /** Net spend per cover, to turn sales into covers. */
  averageSpend: number;
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
  /** Copies of what was seen. Managed by the server: the files are kept apart from the record. */
  documents?: RightToWorkDocument[];
  /** Student permission: the most hours allowed in a Monday to Sunday week during term time. */
  studentWeeklyHourLimit?: number;
  /** Student permission: the institution's official vacations, when full-time work is allowed. */
  termVacations?: { from: string; to: string }[];
}

/**
 * A copy of a right to work document. The statutory excuse needs a clear copy of each document
 * checked, kept for the whole employment and two years after it ends.
 */
export interface RightToWorkDocument {
  id: string;
  fileName: string;
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: number;
  /** SHA-256 of the file as received, so a copy can be shown to be the one uploaded. */
  sha256: string;
  uploadedAt: string;
  uploadedBy: string;
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
  /**
   * Set when the person was linked to a record already in payroll and the two disagree. Nothing is
   * sent to payroll for them until someone decides which side is right.
   */
  payrollReview?: PayrollReview;
  status?: 'active' | 'leaver';
  /** Last day of employment for a leaver. */
  leaveDate?: string;
  /** Set by the API when the reader may not see pay: the rate and salary then read as nought. */
  payHidden?: boolean;
  /**
   * Set by the API when the reader may not see personal details: an adult's date of birth then reads as empty,
   * right to work as checked or not (with an expiry only when it falls within the rota's reach), and the
   * holiday record and card are withheld. `under18` then carries what the young worker rules need.
   */
  personalHidden?: boolean;
  /** With personalHidden: whether the person is under 18 today. */
  under18?: boolean;
  /** Set by the API: a pay change proposed for this person and waiting for finance. */
  pendingPay?: PayChangeSummary;
  /** The UID of the RFID card this person taps to clock in and out, normalised by normaliseBadge. */
  badgeId?: string;
  /** When the person's kiosk PIN was last set, and by whom. The PIN itself is kept hashed, apart from the record. */
  kioskPinSetAt?: string;
  kioskPinSetBy?: 'self' | 'manager';
  /** What the rota should know: preferences, regular commitments, who they work well with. Read by the rota assistant. */
  rotaNotes?: string;
  /** Personnel file: contract, probation, personal details. Managed through the HR endpoints. */
  hr?: HrProfile;
  /** Sickness and other absence. A shift on an absence day is blocked like leave. */
  absences?: Absence[];
  /** One-off days the person has said they cannot work, on top of their weekly availability. */
  unavailable?: Unavailability[];
  /** Set when the retention period ended and the record was anonymised under UK GDPR. */
  anonymisedOn?: string;
  /** How often the person is paid, which sets the minimum wage pay reference period. Weekly when absent. */
  payFrequency?: 'weekly' | 'monthly';
  /**
   * Weekly deductions and payments that reduce pay for minimum wage purposes: uniform or tools the
   * worker pays for, salary sacrifice, and similar.
   */
  nmwReducingDeductionsWeekly?: number;
}

export type ContractType = 'permanent' | 'fixed-term' | 'casual' | 'apprentice';

export interface EmergencyContact {
  name: string;
  relationship?: string;
  phone: string;
}

/** The parts of a personnel file that are about the person and their contract, not the rota. */
export interface HrProfile {
  jobTitle?: string;
  contractType?: ContractType;
  /** Last day of a fixed-term contract. */
  fixedTermEnd?: string;
  /** Last day of probation, and the day it was confirmed as passed. */
  probationEnd?: string;
  probationPassedOn?: string;
  /** Notice the employer must give, in weeks, where the contract gives more than statutory. */
  noticeWeeks?: number;
  /** Written statement of employment particulars: due on or before the first day. */
  contractIssuedOn?: string;
  contractSignedOn?: string;
  handbookAcknowledgedOn?: string;
  /** National Insurance number. Without it payroll runs on an emergency basis. */
  niNumber?: string;
  address?: string;
  postcode?: string;
  emergencyContact?: EmergencyContact;
  /** Line manager's employee id. */
  managerId?: string;
}

export type AbsenceType = 'sickness' | 'unauthorised' | 'compassionate' | 'dependants' | 'family' | 'unpaid' | 'other';

/** A spell of absence other than holiday, which lives on `leave`. Dates are inclusive. */
export interface Absence {
  id: string;
  /**
   * Always stored. Withheld by the API from readers who need only the days off: whether someone was
   * off sick is health data, kept to those who read HR files or see pay (sick pay turns on it).
   */
  type?: AbsenceType;
  from: string;
  /** Last day off. Absent while the person is still off. */
  to?: string;
  reason?: string;
  /** Fit note seen. Needed after seven calendar days of sickness. */
  fitNote?: boolean;
  /** Day the return to work conversation was held. */
  returnToWorkOn?: string;
  /** Disability or pregnancy related: kept out of absence triggers, as the Equality Act requires. */
  excludeFromTriggers?: boolean;
  notes?: string;
  /** Copies of fit notes, stored encrypted like right to work copies and read only by those who read the file. */
  fitNotes?: RightToWorkDocument[];
  /** Set when the person reported it themselves in the staff app. */
  reportedBy?: 'staff';
}

/** A day someone cannot work, outside their usual pattern: a hospital appointment, an exam, a wedding. */
export interface Unavailability {
  date: string;
  note?: string;
}

/**
 * Something a member of staff asks for in the staff app, decided by a manager. Every one is checked
 * by the same engine as the manager's own action, and nothing changes the rota until it is approved.
 */
export type StaffRequestKind = 'holiday' | 'time_off' | 'sickness' | 'availability' | 'swap' | 'open_shift';
/**
 * pending: waiting for a manager (or, for a swap, for the colleague first). accepted: a swap the
 * colleague has agreed, now waiting for a manager. approved and declined are final; cancelled is
 * withdrawn by the person, or overtaken (another claim was approved, the shift changed).
 */
export type StaffRequestStatus = 'pending' | 'accepted' | 'approved' | 'declined' | 'cancelled';

export interface StaffRequest {
  id: string;
  kind: StaffRequestKind;
  employeeId: string;
  /** The site whose manager decides: the person's home site, or the shift's site for swaps and open shifts. */
  siteId: string;
  status: StaffRequestStatus;
  createdAt: string;
  /** Holiday, time off and sickness: first and last day, inclusive. Sickness may run with no last day yet. */
  from?: string;
  to?: string;
  /** Holiday: hours the request takes from the balance. */
  hours?: number;
  /** Time off: the kind of absence it becomes once approved. */
  absenceType?: AbsenceType;
  /** What the person wrote. For sickness and time off this is health or family data: personnel file readers only. */
  note?: string;
  /** Availability: the new weekly pattern, from the date it starts. */
  availability?: Availability[];
  /** Swap: the shift given away, the colleague asked (absent: anyone eligible), and the shift taken in return, if any. */
  shiftId?: string;
  toEmployeeId?: string;
  returnShiftId?: string;
  /** Swap: who agreed to take it. */
  takerId?: string;
  /** Open shift: the one claimed. */
  openShiftId?: string;
  /** Sickness: the absence the report recorded. */
  absenceId?: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
}

/** A shift a manager has posted for anyone eligible to claim. */
export interface OpenShift {
  id: string;
  siteId: string;
  roleId: string;
  date: string;
  startMinute: number;
  endMinute: number;
  breakMinutes: number;
  note?: string;
  status: 'open' | 'filled' | 'withdrawn';
  postedBy: string;
  postedAt: string;
  /** Set once filled: who and the shift it became. */
  filledBy?: string;
  shiftId?: string;
  /** The shift released to make this one, when a manager posted someone's shift for cover. */
  releasedFrom?: { shiftId: string; employeeId: string };
  /**
   * Someone's shift put out while it stays theirs: it moves to whoever takes it, and stays with them
   * if nobody does. Instead of releasedFrom, which takes it off them when it is posted.
   */
  heldBy?: { shiftId: string; employeeId: string };
  /** How it is decided. claim, the default: staff ask and a manager approves. first_yes: the first legal yes gets it at once. */
  fill?: 'claim' | 'first_yes';
  /** Put to these people only, cheapest first, perhaps in rounds. Absent: everyone eligible is told when it is posted. */
  offers?: ShiftOffer[];
  /** Asking in rounds: `size` at a time, the next round every `everyMinutes` until someone takes it. */
  rounds?: { size: number; everyMinutes: number };
  /** When the next round goes, while there is one to come. */
  nextRoundAt?: string;
  /** Told through quiet hours. */
  urgent?: boolean;
}

export type StaffNotificationKind =
  | 'rota_published' | 'rota_changed' | 'shift_cancelled'
  | 'open_shift' | 'swap_offered' | 'swap_accepted' | 'request_decided' | 'request_received';

/** A message to one member of staff, shown in the staff app and emailed where an address is held. */
export interface StaffNotification {
  id: string;
  employeeId: string;
  kind: StaffNotificationKind;
  at: string;
  title: string;
  body: string;
  read?: boolean;
  /** pending until the request that raised it is saved; then sent, none (no email set up or no address) or failed. */
  email?: 'pending' | 'sent' | 'none' | 'failed';
  /** Carried by WhatsApp or text instead of email, for someone who chose that in the staff app. */
  via?: 'whatsapp' | 'sms';
  /** Goes through quiet hours: a shift put out as urgent. */
  urgent?: boolean;
  /** Pushed to the person's phones: sent to at least one, none (not turned on), or failed on every one. */
  push?: 'sent' | 'none' | 'failed';
}

export type HrRecordKind = 'training' | 'review' | 'case' | 'document' | 'note';
export type ReviewType = 'probation' | 'appraisal' | 'one-to-one';
export type CaseType = 'investigation' | 'disciplinary' | 'grievance' | 'capability';

/**
 * One dated entry on a personnel file: a course passed, a review held, a disciplinary
 * or grievance case, a document on file or a note. Kept apart from the rota state so
 * that rota and payroll keys never read it.
 */
export interface HrRecord {
  id: string;
  employeeId: string;
  kind: HrRecordKind;
  /** When it happened: the course date, review date, case opened, document signed. */
  date: string;
  /** Course name, review or case summary, document name. */
  title: string;
  /** Training: certificate expiry. */
  expiresOn?: string;
  reviewType?: ReviewType;
  /** Review: when the next one is due. */
  nextDue?: string;
  caseType?: CaseType;
  caseStatus?: 'open' | 'closed';
  /** Review or case outcome, e.g. 'Passed', 'First written warning'. */
  outcome?: string;
  /** Case: the day a warning stops being live. */
  warningExpires?: string;
  notes?: string;
  createdBy: string;
  createdAt: string;
  /** Every change, oldest first, with what it replaced: a record can always be shown as it stood. Kept by the server. */
  history?: HrRecordChange[];
  /**
   * Copies on file: the signed contract or statement, a warning letter, a fit note, a certificate.
   * Encrypted and stored apart from the record, like right to work copies. Managed by the server.
   */
  files?: RightToWorkDocument[];
}

/** One change to an HR record: who made it, when, and the values it replaced. */
export interface HrRecordChange {
  at: string;
  by: string;
  before: Partial<Omit<HrRecord, 'id' | 'employeeId' | 'kind' | 'createdBy' | 'createdAt' | 'history'>>;
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
  /** 'profile' when worked from the site's typical week. Figures sent by a sales system or the model carry none and win. */
  source?: 'profile';
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
  /** How a clock was made: a card on a site reader, by name on a site device, or on the person's own phone. */
  method?: 'card' | 'device' | 'phone' | 'kiosk';
  clockInLocation?: ClockLocation;
  clockOutLocation?: ClockLocation;
  /** Breaks the person recorded themselves, in minutes on `date` like clockOut. The last may still be running. */
  breaks?: BreakPeriod[];
  approvedBy?: string;
  approvedAt?: string;
}

/**
 * A manager's decision to publish despite a rest breach, with their reason. It covers one breach
 * exactly as it stood: moving either shift, or changing the days worked, makes it a new breach.
 */
export interface RestOverride {
  id: string;
  employeeId: string;
  /** Where the short rest is worked: who may see and withdraw it follows the rota rights there. */
  siteId: string;
  code: 'daily-rest' | 'weekly-rest';
  /** The breach it covers, as `Issue.overrideKey`. */
  key: string;
  reason: string;
  by: string;
  at: string;
}

/** Takings for one trading day at one site, net of VAT: what the till actually rang, not the forecast. */
export interface DaySales {
  siteId: string;
  date: string;
  netSales: number;
  covers?: number;
  /** Where the figure came from: pushed by a till or EPOS system, keyed in, or a file import. */
  source: 'till' | 'manual' | 'import';
  /** Completed orders, where the till reports them. */
  orders?: number;
  /** Takings by hour, from a till feed: history to forecast from. Hours past midnight run on (24 is 00:00 the next morning). */
  hours?: HourSales[];
}

export interface HourSales {
  hour: number;
  netSales: number;
  orders: number;
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
  /** School holidays confirmed for a site: from its council's feed or entered by hand. */
  schoolHolidays?: (SchoolPeriod & { siteId: string })[];
  /** Actual takings by day. Absent on organisations saved before takings were recorded. */
  sales?: DaySales[];
  /** Recorded by the API only; never sent with shifts. */
  restOverrides?: RestOverride[];
  /** Tips, gratuities and service charge taken on the workers' behalf. Absent until a tips feed or entry exists. */
  tips?: TipsTaken[];
  /** Each site's tronc scheme. */
  troncSchemes?: TroncScheme[];
  /** The menu with recipe costs, till sales by dish, supplier invoices and stock counts, for prime cost. */
  dishes?: Dish[];
  dishSales?: DishSales[];
  purchases?: Purchase[];
  stockCounts?: StockCount[];
}

/**
 * Tips, gratuities and service charges the business took on the customer's behalf on one day.
 * Under the Employment (Allocation of Tips) Act 2023 all of it belongs to the workers.
 */
export interface TipsTaken {
  id: string;
  siteId: string;
  date: string;
  source: 'service-charge' | 'card-tip' | 'cash-pooled';
  amount: number;
  /** Date the money reached staff through payroll. */
  paidOn?: string;
  /** Written by the till feed. A figure keyed in by hand has none, and the till never overwrites it. */
  fromTill?: boolean;
}

export interface TroncScheme {
  siteId: string;
  /** The person who decides the allocation. */
  troncmaster: string;
  /** The troncmaster decides the allocation without the employer. Only then are payments free of Class 1 NI. */
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
  /** Who last recorded the scheme, and when: set by the server, never by the caller. */
  updatedBy?: string;
  updatedAt?: string;
}

export type SalesCategory = 'food' | 'drink';

/** One item on the menu: net selling price and the recipe cost of one portion or serve. */
export interface Dish {
  id: string;
  siteId: string;
  name: string;
  category: SalesCategory;
  /** Net of VAT. */
  price: number;
  recipeCost: number;
}

/** Units of one dish sold on one day, from the till. */
export interface DishSales {
  siteId: string;
  date: string;
  dishId: string;
  units: number;
}

/** A supplier invoice or credit note, net of VAT. Credit notes are negative. */
export interface Purchase {
  id: string;
  siteId: string;
  date: string;
  supplier: string;
  category: SalesCategory;
  amount: number;
}

/** Stock on hand at close of business on `date`, at cost. */
export interface StockCount {
  siteId: string;
  date: string;
  category: SalesCategory;
  value: number;
}

/** A field where Preshift and the payroll record disagree. */
export interface PayrollDifference {
  field: 'name' | 'dateOfBirth' | 'payBasis' | 'hourlyRate' | 'annualSalary' | 'contractedHours';
  label: string;
  preshift: string | number;
  payroll: string | number;
  /** A pay rate or salary: deciding it needs the right to change pay. */
  pay: boolean;
}

export interface PayrollReview {
  linkedAt: string;
  /** 'auto' when a starter matched an existing record on name and date of birth. */
  how: 'auto' | 'manual';
  differences: PayrollDifference[];
  /** The pay proposal raised to take payroll's pay, waiting for finance. */
  payChangeId?: string;
}

/** A school holiday. Estimates are the usual pattern; council dates replace them. */
export interface SchoolPeriod {
  id: string;
  start: string;
  /** Last day of the holiday, inclusive. */
  end: string;
  name: string;
  kind: 'half_term' | 'christmas' | 'easter' | 'summer' | 'inset' | 'other';
  source: 'estimate' | 'council' | 'manual';
  feedId?: string;
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

/** The terms a person is paid on. */
export interface PayTerms {
  payBasis: PayBasis;
  hourlyRate: number;
  annualSalary: number;
}

export type PayChangeStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';

/**
 * A change to someone's pay, proposed by a person who sets pay and decided by finance. The rate
 * in force stays as it is until the change is approved; nobody approves their own proposal.
 */
export interface PayChange {
  id: string;
  employeeId: string;
  /** Home site when proposed: decides who may see and approve it. */
  siteId: string;
  /** Terms in force when proposed. Approval is refused if they have moved since. */
  before: PayTerms;
  after: PayTerms;
  reason?: string;
  status: PayChangeStatus;
  requestedBy: string;
  /** The person's access record id, when a person proposed it. */
  requestedById?: string;
  requestedAt: string;
  decidedBy?: string;
  decidedById?: string;
  decidedAt?: string;
  note?: string;
  /**
   * The date the new pay is agreed from. Absent means from the day it is approved. A date ahead is
   * applied on that day; a date already past is applied on approval, with back pay for the gap.
   */
  effectiveFrom?: string;
  /** The day the new terms went onto the person's record. Absent on an approved change still to take effect. */
  appliedOn?: string;
  /** Pay owed for work between the effective date and the day the change was applied. */
  backPay?: BackPay;
  /**
   * Set when the change applied without a second person: made by a system key, or by a person when
   * nobody else could approve. Every change to pay is on this list, however it was made.
   */
  direct?: 'system' | 'no_approver';
}

/** Arrears from a pay change approved after the date it was agreed from. */
export interface BackPay {
  from: string;
  to: string;
  /** Hours worked in the gap, for hourly pay. */
  hours: number;
  /** Gross owed, before holiday, employer NI and pension. */
  amount: number;
  /** Clocked and approved hours, or the rota where nothing was clocked. */
  basis: 'clocked' | 'rota' | 'salary';
  /** The payroll submission it went to TeamPay with. Absent until it is sent. */
  sentIn?: string;
}

/** What a person's record carries about a change waiting for approval. */
export type PayChangeSummary = Pick<PayChange, 'id' | 'after' | 'reason' | 'requestedBy' | 'requestedAt' | 'effectiveFrom'>;
