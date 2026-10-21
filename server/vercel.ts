// Vercel entry point. scripts/build-vercel.mjs bundles this file into a single
// CommonJS serverless function, so __dirname is the function's own directory.
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { buildApp } from './app';
import { loadApiKeys } from './auth';

// The hosted app is behind sign-in: people reach the API with their session cookie, and
// integrations with keys from PRESHIFT_API_KEYS. People, the session key and the Claude key all
// live in the database and are managed in the app. There is no public fallback key.
const ready = (async () => {
  const { app } = await buildApp({
    apiKeys: loadApiKeys({ ...process.env, NODE_ENV: 'production' }),
    docsBaseDir: path.join(__dirname, 'static'),
    // A demo deployment (PRESHIFT_DEMO=1) greets visitors with a start button rather than sign-in.
    loginPage: path.join(__dirname, process.env.PRESHIFT_DEMO === '1' ? 'demo.html' : 'login.html'),
    appDir: path.join(__dirname, 'app'),
  });
  await app.ready();
  return app;
})();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  // Routes rewrite the API, sign-in, app and assistant paths to this function with the original
  // path in __p. Put it back so Fastify routes on the path the client asked for.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const original = url.searchParams.get('__p');
  if (original) {
    url.searchParams.delete('__p');
    req.url = original + url.search;
  }
  app.server.emit('request', req, res);
}
