import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { MemoryStore } from './store';

// The live checks wait for a deploy by reading which commit /health reports.
async function health(env: NodeJS.ProcessEnv) {
  const { app } = await buildApp({ store: new MemoryStore(['demo'], '2026-10-22'), env });
  return (await app.inject({ method: 'GET', url: '/health' })).json() as { ok: boolean; commit?: string };
}

describe('the health check', () => {
  it('reports the short commit a Vercel git deployment is running', async () => {
    expect((await health({ VERCEL_GIT_COMMIT_SHA: '6b8530a82c2a7f8b9ace578fdc2bac4ca9dd4432' })).commit).toBe('6b8530a');
  });

  it('says nothing about a commit when it is not running from a git deployment', async () => {
    const body = await health({});
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('commit');
  });
});
