// Vercel entry point. scripts/build-vercel.mjs bundles this file into a single
// CommonJS serverless function, so __dirname is the function's own directory.
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { buildApp } from './app';
import { loadApiKeys, type ApiKey } from './auth';

// The hosted demo is public: the web app ships this key in its bundle. Set
// PRESHIFT_API_KEYS in Vercel to replace it once real customer data is involved.
const DEMO_KEY: ApiKey = { key: 'dev-key', orgId: 'demo', name: 'Public demo', scopes: ['*'] };

const ready = (async () => {
  const keys = loadApiKeys(process.env);
  const { app } = await buildApp({
    apiKeys: keys.length ? keys : [DEMO_KEY],
    docsBaseDir: path.join(__dirname, 'static'),
  });
  await app.ready();
  return app;
})();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  // Routes rewrite /v1/*, /docs and /health to this function with the original
  // path in __p. Put it back so Fastify routes on the path the client asked for.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const original = url.searchParams.get('__p');
  if (original) {
    url.searchParams.delete('__p');
    req.url = original + url.search;
  }
  app.server.emit('request', req, res);
}
