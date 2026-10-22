import { buildApp } from './app';
import { createPool } from './db';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL to the preshift_app connection.');

const app = buildApp({
  db: createPool(url),
  allowSignup: process.env.ALLOW_SIGNUP === 'true',
  allowDemoSeed: process.env.ALLOW_DEMO_SEED === 'true',
  secureCookies: process.env.NODE_ENV === 'production',
  logErrors: true,
});

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: process.env.HOST ?? '127.0.0.1' }).then(() => console.log(`Preshift API on :${port}`));
