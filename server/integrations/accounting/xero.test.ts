import { describe, expect, it } from 'vitest';
import { AccountingError } from './provider';
import { XeroAuth, XeroProvider } from './xero';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A Xero stand-in that records what it is sent and answers from a script. */
function fakeXero(answer: (req: Sent) => { status?: number; body?: unknown }) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const req = { url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined };
    sent.push(req);
    const { status = 200, body = {} } = answer(req);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const config = { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://preshift.example/v1/integrations/xero/callback', scopes: 'openid offline_access accounting.transactions' };
const journal = {
  narration: 'Preshift labour accrual w/e 2026-10-25',
  date: '2026-10-25',
  lines: [
    { accountCode: '5000', description: 'Wages - Server', amount: 1000, tracking: { name: 'Site', option: 'MAR' } },
    { accountCode: '2210', description: 'Wages accrual', amount: -1000 },
  ],
};

describe('signing in to Xero', () => {
  it('sends the person to Xero with the app, the scopes and the state', () => {
    const url = new URL(new XeroAuth(config, fetch).authorizeUrl('abc'));
    expect(url.origin + url.pathname).toBe('https://login.xero.com/identity/connect/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', client_id: 'client', redirect_uri: config.redirectUri, scope: config.scopes, state: 'abc' });
  });

  it('exchanges the code for tokens with the app credentials, and lists only organisations', async () => {
    const x = fakeXero((req) =>
      req.url.endsWith('/connect/token')
        ? { body: { access_token: 'at', refresh_token: 'rt', expires_in: 1800 } }
        : { body: [{ id: 'c1', tenantId: 't1', tenantType: 'ORGANISATION', tenantName: 'West End Dining Ltd' }, { id: 'c2', tenantId: 'p1', tenantType: 'PRACTICE', tenantName: 'A practice' }] },
    );
    const auth = new XeroAuth(config, x.fetch, () => new Date('2026-10-24T09:00:00Z'));
    const tokens = await auth.exchange('the-code');
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.parse('2026-10-24T09:30:00Z') });
    expect(x.sent[0].headers.authorization).toBe(`Basic ${Buffer.from('client:secret').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(x.sent[0].body))).toEqual({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: config.redirectUri });
    expect(await auth.tenants('at')).toEqual([{ tenantId: 't1', name: 'West End Dining Ltd', connectionId: 'c1' }]);
  });

  it('says to connect again when Xero refuses a refresh', async () => {
    const x = fakeXero(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    await expect(new XeroAuth(config, x.fetch).refresh('old')).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/Connect Xero again/) });
  });
});

describe('posting to Xero', () => {
  const provider = (answer: Parameters<typeof fakeXero>[0]) => {
    const x = fakeXero(answer);
    return { ...x, xero: new XeroProvider({ accessToken: async () => 'at', fetch: x.fetch }) };
  };

  it('posts a manual journal without tax, tagged by site, to the organisation named, once', async () => {
    const p = provider(() => ({ body: { ManualJournals: [{ ManualJournalID: 'mj-1' }] } }));
    expect(await p.xero.postJournal('t1', journal, 'DRAFT', 'jp_1:accrual')).toEqual({ journalId: 'mj-1' });
    const [req] = p.sent;
    expect(req.url).toBe('https://api.xero.com/api.xro/2.0/ManualJournals');
    expect(req.headers).toMatchObject({ authorization: 'Bearer at', 'xero-tenant-id': 't1', 'idempotency-key': 'jp_1:accrual' });
    expect(JSON.parse(req.body!)).toEqual({
      ManualJournals: [
        {
          Narration: journal.narration,
          Date: '2026-10-25',
          Status: 'DRAFT',
          LineAmountTypes: 'NoTax',
          JournalLines: [
            { LineAmount: 1000, AccountCode: '5000', Description: 'Wages - Server', TaxType: 'NONE', Tracking: [{ Name: 'Site', Option: 'MAR' }] },
            { LineAmount: -1000, AccountCode: '2210', Description: 'Wages accrual', TaxType: 'NONE' },
          ],
        },
      ],
    });
  });

  it('voids a posted journal and deletes a draft', async () => {
    const p = provider(() => ({ body: {} }));
    await p.xero.removeJournal('t1', 'mj-1', 'POSTED');
    await p.xero.removeJournal('t1', 'mj-2', 'DRAFT');
    expect(p.sent.map((r) => JSON.parse(r.body!).ManualJournals[0])).toEqual([{ ManualJournalID: 'mj-1', Status: 'VOIDED' }, { ManualJournalID: 'mj-2', Status: 'DELETED' }]);
  });

  it('reads the chart and tracking, leaving out what is archived', async () => {
    const p = provider((req) =>
      req.url.endsWith('/Accounts')
        ? { body: { Accounts: [{ Code: '5000', Name: 'Wages', Status: 'ACTIVE' }, { Code: '7999', Name: 'Old', Status: 'ARCHIVED' }, { Name: 'Bank', Status: 'ACTIVE' }] } }
        : { body: { TrackingCategories: [{ Name: 'Site', Status: 'ACTIVE', Options: [{ Name: 'MAR', Status: 'ACTIVE' }, { Name: 'OLD', Status: 'ARCHIVED' }] }, { Name: 'Gone', Status: 'ARCHIVED' }] } },
    );
    expect(await p.xero.accounts('t1')).toEqual([{ code: '5000', name: 'Wages', status: 'ACTIVE' }, { code: '7999', name: 'Old', status: 'ARCHIVED' }]);
    expect(await p.xero.tracking('t1')).toEqual([{ name: 'Site', options: ['MAR'] }]);
  });

  it("passes on Xero's own reasons for refusing a journal, and tells a lost connection from a busy one", async () => {
    const refused = provider(() => ({ status: 400, body: { Message: 'A validation exception occurred', Elements: [{ ValidationErrors: [{ Message: 'The document date cannot be before the period lock date of 31/10/2026' }] }] } }));
    await expect(refused.xero.postJournal('t1', journal, 'POSTED', 'k')).rejects.toThrow('Xero refused the journal: The document date cannot be before the period lock date of 31/10/2026');
    const lost = provider(() => ({ status: 401 }));
    await expect(lost.xero.accounts('t1')).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/Connect Xero again/) });
    const busy = provider(() => ({ status: 429 }));
    const err = await busy.xero.accounts('t1').catch((e) => e);
    expect(err).toBeInstanceOf(AccountingError);
    expect(err.retryable).toBe(true);
  });
});
