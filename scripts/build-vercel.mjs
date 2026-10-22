// Builds the Vercel deployment with the Build Output API (.vercel/output):
//   /         marketing site (site/)
//   /v1, /docs, /health   Preshift API as one bundled Node function, which also serves:
//   /login, /auth/*       sign-in, first-run owner setup and sign-out
//   /demo                 the public demo's sandbox per visitor (PRESHIFT_DEMO=1), else a redirect
//   /app/                 the rota web app (Vite build), only to signed-in people
//   /staff/               the staff app for clocking on their own phones (public page, own sign-in)
//   /api/anthropic/v1/messages   the rota assistant's route to Claude
//   /internal/dispatch    daily cron retry of undelivered payroll changes
//   /internal/webhooks    webhook retries every 15 minutes
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const out = '.vercel/output';
const fn = `${out}/functions/api.func`;
const require = createRequire(import.meta.url);

await rm(out, { recursive: true, force: true });

// The app is built into the API function, not static output, so nothing under /app is public.
await viteBuild({ base: '/app/', build: { outDir: `${fn}/app`, emptyOutDir: true }, logLevel: 'warn' });
// The staff app is its own small build, rooted in staff/, so none of the manager app ships with it.
await viteBuild({
  root: 'staff',
  configFile: path.resolve('vite.config.ts'),
  base: '/staff/',
  build: { outDir: path.resolve(`${fn}/staff`), emptyOutDir: true },
  logLevel: 'warn',
});
await mkdir(fn, { recursive: true });
await cp('site/login.html', `${fn}/login.html`);
await cp('site/demo.html', `${fn}/demo.html`);

for (const f of ['index.html', 'styles.css', 'main.js', 'img']) {
  await cp(`site/${f}`, `${out}/static/${f}`, { recursive: true });
}

// Each function is one CommonJS file exporting the (req, res) handler itself.
async function nodeFunction(dir, entry, extra = {}) {
  await esbuild({
    ...entry,
    outfile: `${dir}/index.cjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    footer: { js: 'module.exports = module.exports.default;' },
    logLevel: 'warning',
  });
  await writeFile(
    `${dir}/.vc-config.json`,
    JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.cjs', launcherType: 'Nodejs', shouldAddHelpers: false, ...extra }, null, 2),
  );
}

// The assistant's calls to Claude can run for minutes, so the function gets the full allowance.
await nodeFunction(fn, { entryPoints: ['server/vercel.ts'] }, { maxDuration: 300 });
// Swagger UI reads its assets from disk at runtime.
const swaggerUi = path.dirname(require.resolve('@fastify/swagger-ui/package.json'));
await cp(path.join(swaggerUi, 'static'), `${fn}/static`, { recursive: true });

await mkdir(out, { recursive: true });
await writeFile(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: '^/(v1(?:/.*)?|docs(?:/.*)?|health|internal/dispatch|internal/webhooks|login|demo|auth/.*|app(?:/.*)?|staff(?:/.*)?|api/anthropic/.*)$',
          dest: '/api?__p=/$1',
        },
        { handle: 'filesystem' },
      ],
      // Safety nets (need CRON_SECRET): payroll changes TeamPay has not confirmed, daily; webhook
      // retries every 15 minutes, which needs a Vercel plan that runs cron jobs more than daily.
      crons: [
        { path: '/internal/dispatch', schedule: '0 6 * * *' },
        { path: '/internal/webhooks', schedule: '*/15 * * * *' },
      ],
    },
    null,
    2,
  ),
);

console.log(`Built ${out}`);
