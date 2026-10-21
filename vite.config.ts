import { defineConfig } from 'vitest/config';
import { loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Read without the VITE_ prefix so the key stays on the server and is never bundled.
  const apiKey = loadEnv(mode, process.cwd(), '').ANTHROPIC_API_KEY;

  // The rota assistant calls /api/anthropic; this adds the key and forwards to the Claude API.
  const anthropicProxy: Record<string, ProxyOptions> = {
    '/api/anthropic': {
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
      configure: (proxy) => {
        proxy.on('proxyReq', (req) => {
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
    server: { proxy: anthropicProxy },
    preview: { proxy: anthropicProxy },
    test: { globals: true, environment: 'node' },
  };
});
