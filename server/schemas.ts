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
