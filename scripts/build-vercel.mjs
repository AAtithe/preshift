// Builds the Vercel deployment with the Build Output API (.vercel/output):
//   /         marketing site (site/)
//   /login    sign-in page (site/login.html)
//   /app/     rota web app (Vite build), served only to signed-in users by the app gate function
//   /api/auth/login, /api/auth/logout, /api/auth/me   sign-in, one function (server/signin.ts)
//   /v1, /docs, /health   Preshift API as one bundled Node function
//   /internal/dispatch    daily cron retry of undelivered payroll changes
//   /api/anthropic/v1/messages   rota assistant proxy (api/anthropic/v1/messages.js)
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const out = '.vercel/output';
const fn = `${out}/functions/api.func`;
const require = createRequire(import.meta.url);

await rm(out, { recursive: true, force: true });

// The app is built into the gate function, not static output, so nothing under /app is public.
const gate = `${out}/functions/app-gate.func`;
await viteBuild({ base: '/app/', build: { outDir: `${gate}/files`, emptyOutDir: true }, logLevel: 'warn' });

for (const f of ['index.html', 'login.html', 'styles.css', 'main.js', 'img']) {
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

await nodeFunction(fn, { entryPoints: ['server/vercel.ts'] });
// Swagger UI reads its assets from disk at runtime.
const swaggerUi = path.dirname(require.resolve('@fastify/swagger-ui/package.json'));
await cp(path.join(swaggerUi, 'static'), `${fn}/static`, { recursive: true });

// Web-handler modules (export async function GET/POST) wrapped as Node functions.
const webFunction = (dir, imports, exportExpr, extra) =>
  nodeFunction(
    dir,
    {
      stdin: {
        contents: `${imports}\nimport { toNodeHandler } from './scripts/web-to-node.mjs';\nexport default toNodeHandler(${exportExpr});\n`,
        resolveDir: process.cwd(),
        sourcefile: `${path.basename(dir)}-entry.mjs`,
      },
    },
    extra,
  );

// Outside functions/api/ and reached by its own route, so nothing Vercel builds from the
// repository's api/ folder can sit on these paths.
await webFunction(
  `${out}/functions/auth.func`,
  "import { handleAuth } from './server/signin';\n" +
    'const handle = (request) => {\n' +
    '  const url = new URL(request.url);\n' +
    "  const original = url.searchParams.get('__p');\n" +
    "  if (original) { url.searchParams.delete('__p'); url.pathname = original; }\n" +
    '  return handleAuth(new Request(url, request));\n' +
    '};',
  '{ GET: handle, POST: handle }',
);

// Routes send /app/* here with the original path in __p; restore it before the session check.
await webFunction(
  gate,
  "import path from 'node:path';\nimport { createAppGate } from './server/appGate';\n" +
    "const serve = createAppGate(path.join(__dirname, 'files'));\n" +
    'const GET = (request) => {\n' +
    '  const url = new URL(request.url);\n' +
    "  const original = url.searchParams.get('__p');\n" +
    "  if (original) { url.searchParams.delete('__p'); url.pathname = original; }\n" +
    '  return serve(new Request(url, request));\n' +
    '};',
  '{ GET, HEAD: GET }',
);

await nodeFunction(
  `${out}/functions/api/anthropic/v1/messages.func`,
  {
    stdin: {
      contents:
        "import * as mod from './api/anthropic/v1/messages.js';\n" +
        "import { toNodeHandler } from './scripts/web-to-node.mjs';\n" +
        'export default toNodeHandler(mod);\n',
      resolveDir: process.cwd(),
      sourcefile: 'anthropic-entry.mjs',
    },
  },
  { maxDuration: 300 },
);

await mkdir(out, { recursive: true });
await writeFile(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/(v1(?:/.*)?|docs(?:/.*)?|health|internal/dispatch)$', dest: '/api?__p=/$1' },
        { src: '^/api/auth/(login|logout|me)$', dest: '/auth?__p=/api/auth/$1' },
        { src: '^/login$', dest: '/login.html' },
        { src: '^/app(/.*)?$', dest: '/app-gate?__p=/app$1' },
        { handle: 'filesystem' },
      ],
      // Safety net for payroll changes TeamPay has not yet confirmed (needs CRON_SECRET).
      crons: [{ path: '/internal/dispatch', schedule: '0 6 * * *' }],
    },
    null,
    2,
  ),
);

console.log(`Built ${out}`);
