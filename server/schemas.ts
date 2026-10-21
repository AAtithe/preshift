// JSON Schemas for request validation. Fastify validates against these and
// they generate the OpenAPI document served at /docs.

export const isoDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
export const minute = { type: 'integer', minimum: 0, maximum: 2880 } as const;

export const siteWeekQuery = {
  type: 'object',
  required: ['siteId', 'weekStart'],
  properties: { siteId: { type: 'string' }, weekStart: isoDate },
} as const;

export const rangeQuery = {
  type: 'object',
  properties: { siteId: { type: 'string' }, from: isoDate, to: isoDate },
} as const;

/** One site (`siteId`) or several (`siteIds`) for a week, so a group can be built or published in one call. */
export const sitesWeekBody = {
  type: 'object',
  required: ['weekStart'],
  properties: {
    siteId: { type: 'string' },
    siteIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 },
    weekStart: isoDate,
  },
} as const;

export const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;

export const shiftBody = {
  type: 'object',
  required: ['employeeId', 'roleId', 'siteId', 'date', 'startMinute', 'endMinute'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    employeeId: { type: 'string' },
    roleId: { type: 'string' },
    siteId: { type: 'string' },
    date: isoDate,
    startMinute: minute,
    endMinute: minute,
    breakMinutes: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const employeeBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    siteId: { type: 'string' },
    entityId: { type: 'string', description: 'Employing company. Defaults to the company of their home site.' },
    coverSiteIds: { type: 'array', items: { type: 'string' }, description: 'Other sites they will cover.' },
    roleIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    payBasis: { type: 'string', enum: ['hourly', 'salaried'] },
    hourlyRate: { type: 'number', minimum: 0 },
    annualSalary: { type: 'number', minimum: 0 },
    dateOfBirth: isoDate,
    contractedHours: { type: 'number', minimum: 0 },
    maxWeeklyHours: { type: 'number', minimum: 0 },
    optedOutOf48: { type: 'boolean' },
    irregularHours: { type: 'boolean' },
    pensionEnrolled: { type: 'boolean' },
    availability: {
      type: 'array',
      items: {
        type: 'object',
        required: ['weekday', 'fromMinute', 'toMinute'],
        properties: { weekday: { type: 'integer', minimum: 0, maximum: 6 }, fromMinute: minute, toMinute: minute },
      },
    },
    leave: { type: 'array', items: isoDate },
    email: { type: 'string' },
    phone: { type: 'string' },
    startDate: isoDate,
    rightToWork: {
      type: 'object',
      required: ['checked'],
      additionalProperties: false,
      properties: { checked: { type: 'boolean' }, checkedOn: isoDate, evidence: { type: 'string' }, expiry: isoDate },
    },
  },
} as const;

export const forecastBody = {
  type: 'object',
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      maxItems: 20000,
      items: {
        type: 'object',
        required: ['siteId', 'date', 'hour', 'sales', 'covers'],
        properties: {
          siteId: { type: 'string' },
          date: isoDate,
          hour: { type: 'integer', minimum: 0, maximum: 23 },
          sales: { type: 'number', minimum: 0 },
          covers: { type: 'number', minimum: 0 },
        },
      },
    },
  },
} as const;

export const timeEntryBody = {
  type: 'object',
  required: ['employeeId', 'siteId', 'roleId', 'date', 'clockIn', 'clockOut'],
  additionalProperties: false,
  properties: {
    employeeId: { type: 'string' },
    siteId: { type: 'string' },
    roleId: { type: 'string' },
    shiftId: { type: 'string' },
    date: isoDate,
    clockIn: minute,
    clockOut: minute,
    breakMinutes: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

/** A browser Geolocation fix. */
export const geoFixBody = {
  type: 'object',
  required: ['lat', 'lng', 'accuracyMetres'],
  additionalProperties: false,
  properties: {
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
    accuracyMetres: { type: 'number', minimum: 0 },
  },
} as const;

export const geofenceBody = {
  type: 'object',
  required: ['lat', 'lng', 'radiusMetres'],
  additionalProperties: false,
  properties: {
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
    radiusMetres: { type: 'integer', minimum: 25, maximum: 2000 },
  },
} as const;
