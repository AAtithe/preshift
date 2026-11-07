import { describe, expect, it } from 'vitest';
import { columnProfiles, mapColumnsWithAI } from './importMapper';
import type { MessagesClient } from './messagesClient';

// Shifty maps a file's columns without seeing anyone's personal details.

const rows = [
  ['Staff', 'Contact', 'Job', 'Loc', 'Per hr', 'Born', 'NINO', 'Phone'],
  ['Pat Lee', 'pat@x.example', 'Server', 'Clerkenwell', '12.71', '30/06/1990', 'QQ123456C', '07700900123'],
  ['Jo Ray', 'jo@x.example', 'Server', 'Clerkenwell', '12.71', '12/04/1985', 'QQ654321C', '07700900456'],
  ['Sam Cook', 'sam@x.example', 'Chef', 'Shoreditch', '15.50', '01/01/2000', 'QQ111111C', '07700900789'],
];

describe('column profiles', () => {
  it('shows categories and small numbers, and masks anything that may be a person', () => {
    const p = columnProfiles(rows);
    expect(p.map((c) => c.examples)).toEqual([
      ['<Aaa Aaa>', '<Aa Aaa>', '<Aaa Aaaa>'],
      ['<an email address>'],
      ['Server', '<Aaaa>'],
      ['Clerkenwell', '<Aaaaaaaaaa>'],
      ['12.71', '15.50'],
      ['<99/99/9999>'],
      ['<AA999999A>'],
      ['<99999999999>'],
    ]);
  });
});

describe('mapping with Claude', () => {
  it('sends no personal value, and keeps only real headers, each used once', async () => {
    const sent: string[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: unknown) => {
            sent.push(JSON.stringify(params));
            return {
              usage: { input_tokens: 1000, output_tokens: 100 },
              content: [{ type: 'tool_use', id: 't', name: 'map_columns', input: { name: 'Staff', roles: 'Job', site: 'Loc', rate: 'Per hr', dateOfBirth: 'Born', email: 'Staff', salary: 'Made up', notes: 'No start date column.' } }],
            };
          },
        },
      },
    } as unknown as MessagesClient;
    const r = await mapColumnsWithAI(client, 'team', rows);
    expect(r.columns).toEqual({ name: 'Staff', roles: 'Job', site: 'Loc', rate: 'Per hr', dateOfBirth: 'Born' });
    expect(r.notes).toBe('No start date column.');
    for (const secret of ['Pat Lee', 'pat@x.example', '30/06/1990', 'QQ123456C', '07700900123']) expect(sent[0]).not.toContain(secret);
  });
});
