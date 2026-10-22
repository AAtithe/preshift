import { configDefaults, defineConfig } from 'vitest/config';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  // The Preshift API runs on :8787 in development (npm run dev starts both). It also handles
  // sign-in, the sign-in page and the rota assistant's route to Claude.
  const api = 'http://localhost:8787';
  const proxy: Record<string, string | ProxyOptions> = {
    '/v1': api,
    '/docs': api,
    '/auth': api,
    '/login': api,
    '/demo': api,
    '/api': api,
  };

  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
    // The Postgres tests run a real database engine in-process (PGlite), which is slow under parallel load.
    // The browser checks in e2e/ run under Playwright, not vitest.
    test: { globals: true, environment: 'node', testTimeout: 30_000, exclude: [...configDefaults.exclude, 'e2e/**'] },
  };
});
