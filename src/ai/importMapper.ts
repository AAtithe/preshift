import type Anthropic from '@anthropic-ai/sdk';
import { parseTime } from '../engine/bookingImport';
import { HOLIDAY_COLUMNS, PEOPLE_COLUMNS, SHIFT_COLUMNS, table } from '../engine/externalImport';
import type { MessagesClient } from './messagesClient';
import { usageCostUsd } from './pricing';
import { ROTA_MODEL } from './rotaAgent';

// Shifty maps the columns of a file from another system onto what Preshift needs, when matching by
// name has not found them all. It is shown only the headers and the kind of value in each column:
// a value that appears once (a name, an email, a date of birth, an NI number) is masked as its shape,
// so no member of staff's personal details ever leave Preshift for the model. Values repeated down a
// column (roles, sites, contracted hours) and times of day are shown, because they say what the
// column is without saying who anyone is. The manager sees the mapping and can change it before anything is read.

export type ImportKind = 'team' | 'rota' | 'holiday';

export const IMPORT_FIELDS: Record<ImportKind, Record<string, string>> = {
  team: {
    name: 'Full name in one column',
    firstName: 'First name, where the name is split',
    lastName: 'Last name, where the name is split',
    email: "The person's email",
    roles: 'Role, position or job title',
    rate: 'Hourly rate of pay',
    salary: 'Annual salary',
    dateOfBirth: 'Date of birth',
    contractedHours: 'Contracted or guaranteed hours a week',
    startDate: 'Employment start or hire date',
    site: 'Home site, location or venue',
    rightToWork: 'Date the right to work check was done',
  },
  rota: {
    name: "Employee's full name in one column",
    firstName: 'First name, where the name is split',
    lastName: 'Last name, where the name is split',
    email: "Employee's email",
    date: 'Date of the shift',
    start: 'Shift start time (may include the date)',
    end: 'Shift end time (may include the date)',
    breakMinutes: 'Unpaid break length',
    role: 'Role, position or area worked',
    site: 'Site, location or venue',
  },
  holiday: {
    name: "Employee's full name in one column",
    firstName: 'First name, where the name is split',
    lastName: 'Last name, where the name is split',
    email: "Employee's email",
    accrued: 'Holiday accrued or earned so far this leave year',
    taken: 'Holiday taken or used so far this leave year',
    carriedOver: 'Holiday carried over from last leave year',
    remaining: 'Holiday balance remaining',
    entitlementWeeks: 'Contractual entitlement in weeks a year',
  },
};

const ALIASES: Record<ImportKind, Record<string, string[]>> = { team: PEOPLE_COLUMNS, rota: SHIFT_COLUMNS, holiday: HOLIDAY_COLUMNS };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^-?[£$€]?\d+(?:[.,]\d+)?$/;

/** A value as its shape: letters to a, digits to 9. "30/06/1990" is "99/99/9999", "QQ123456C" is "AA999999A". */
const shape = (v: string) => v.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? 'A' : 'a')).replace(/\d/g, '9').slice(0, 24);

export interface ColumnProfile {
  header: string;
  /** Up to four example values, safe to show: personal values masked as their shape. */
  examples: string[];
  filled: number;
}

/** What each column holds, with nothing that identifies anyone. */
export function columnProfiles(rows: string[][]): ColumnProfile[] {
  const [headers = [], ...data] = rows;
  const sample = data.slice(0, 200);
  return headers.map((header, i) => {
    const values = sample.map((r) => (r[i] ?? '').trim()).filter(Boolean);
    const count = new Map<string, number>();
    for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
    const examples: string[] = [];
    for (const v of values) {
      let shown: string;
      if (EMAIL.test(v)) shown = '<an email address>';
      // Times of day say a column is a start or end time and identify nobody.
      else if (parseTime(v) !== null && /[:.]|am|pm/i.test(v)) shown = v;
      // A small number repeated down a column is hours, a break or a rate band, not a phone number.
      else if (NUMBER.test(v) && v.replace(/\D/g, '').length <= 6) shown = v;
      // Anything repeated is a category (a role, a site); anything once may be a person's own.
      else if ((count.get(v) ?? 0) >= 2 && v.length <= 40) shown = v;
      else shown = `<${shape(v)}>`;
      if (!examples.includes(shown)) examples.push(shown);
      if (examples.length >= 4) break;
    }
    return { header, examples, filled: values.length };
  });
}

export interface AiMapping {
  columns: Record<string, string>;
  notes: string;
  costUsd: number;
}

/** Asks Claude which column holds each field. Returns only headers that exist in the file. */
export async function mapColumnsWithAI(client: MessagesClient, kind: ImportKind, input: string[][], signal?: AbortSignal): Promise<AiMapping> {
  const { rows } = table(input, ALIASES[kind]);
  const profiles = columnProfiles(rows);
  const headers = profiles.map((p) => p.header).filter((h) => h.trim());
  const fields = IMPORT_FIELDS[kind];
  const properties = Object.fromEntries(
    Object.entries(fields).map(([field, about]) => [field, { anyOf: [{ type: 'string', enum: headers }, { type: 'null' }], description: about }]),
  );
  const tool = {
    name: 'map_columns',
    description: 'Say which column of the file holds each field Preshift needs. Null where no column holds it.',
    input_schema: { type: 'object' as const, properties: { ...properties, notes: { type: 'string', description: 'One or two plain sentences for the manager: anything doubtful, and anything the file is missing that the import needs.' } }, required: [...Object.keys(fields), 'notes'], additionalProperties: false },
  };
  const what = { team: 'a team or employee list', rota: 'a rota or schedule of shifts', holiday: 'holiday balances' }[kind];
  const response = await client.beta.messages.create(
    {
      model: ROTA_MODEL,
      max_tokens: 2000,
      system:
        'You map the columns of a spreadsheet exported from a UK hospitality business\'s old rota, HR or payroll system onto the fields Preshift imports. ' +
        'You see each header and up to four example values. Values in angle brackets are masked as their shape (A a letter, 9 a digit) because they are personal. ' +
        'Map a field only to a column that clearly holds it; when unsure, leave it null and say so in the notes. Never map one column to two fields, except a column holding both date and start time may be the start alone. ' +
        'Pay columns: an hourly figure is a rate, a figure in thousands is a salary. Holiday figures may be in hours or days; say which in the notes. Write in plain British English.',
      tools: [tool],
      tool_choice: { type: 'tool', name: 'map_columns' },
      messages: [{ role: 'user', content: `The file is ${what}. Its columns:\n${JSON.stringify(profiles, null, 1)}` }],
    } as unknown as Parameters<MessagesClient['beta']['messages']['create']>[0],
    { signal },
  );
  const use = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
  const out = (use?.input ?? {}) as Record<string, unknown>;
  const columns: Record<string, string> = {};
  const taken = new Set<string>();
  for (const field of Object.keys(fields)) {
    const h = out[field];
    if (typeof h === 'string' && headers.includes(h) && !taken.has(h)) {
      columns[field] = h;
      taken.add(h);
    }
  }
  return { columns, notes: typeof out.notes === 'string' ? out.notes : '', costUsd: usageCostUsd(response.usage) };
}
