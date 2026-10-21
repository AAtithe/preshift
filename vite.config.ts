import { defineConfig } from 'vitest/config';
import { loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Read without the VITE_ prefix so the key stays on the server and is never bundled.
  const apiKey = loadEnv(mode, process.cwd(), '').ANTHROPIC_API_KEY;

  const proxy: Record<string, string | ProxyOptions> = {
    // The Preshift API (npm run dev:api).
    '/v1': 'http://localhost:8787',
    '/docs': 'http://localhost:8787',
    // The rota assistant calls /api/anthropic; this adds the key and forwards to the Claude API.
    // In production the Preshift API serves the same route (server/routes/anthropic.ts).
    '/api/anthropic': {
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
      configure: (p) => {
        p.on('proxyReq', (req) => {
          req.removeHeader('authorization');
          req.removeHeader('anthropic-dangerous-direct-browser-access');
          if (apiKey) req.setHeader('x-api-key', apiKey);
          else req.removeHeader('x-api-key');
        });
      },
    },
  };

  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
    test: { globals: true, environment: 'node' },
  };
});
