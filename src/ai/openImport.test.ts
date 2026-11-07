import { describe, expect, it } from 'vitest';
import { executeAppTool, type AppToolContext } from './appTools';

// Shifty opens Set-up on the Import tab asked for, without a confirmation, and refuses a tab that does not exist.

const ctx = { state: { employees: [], shifts: [], sites: [], roles: [], entities: [] }, siteIds: [], week: '2026-11-02', now: { date: '2026-11-06', minute: 600 }, loadEntries: async () => [] } as unknown as AppToolContext;

describe('open_import', () => {
  it('opens the tab asked for', async () => {
    const out = await executeAppTool(ctx, 'open_import', { kind: 'holiday' });
    expect(out.proposal).toMatchObject({ kind: 'open_import', importKind: 'holiday' });
  });

  it('refuses a tab that does not exist', async () => {
    const out = await executeAppTool(ctx, 'open_import', { kind: 'pensions' });
    expect(out.isError).toBe(true);
  });
});
