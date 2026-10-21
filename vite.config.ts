import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/v1': 'http://localhost:8787', '/docs': 'http://localhost:8787' } },
  preview: { proxy: { '/v1': 'http://localhost:8787', '/docs': 'http://localhost:8787' } },
  test: { globals: true, environment: 'node' },
});
