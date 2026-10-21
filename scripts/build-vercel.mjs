// Builds the Vercel deployment with the Build Output API (.vercel/output):
//   /         marketing site (site/)
//   /app/     rota web app (Vite build)
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

await viteBuild({ base: '/app/', build: { outDir: `${out}/static/app`, emptyOutDir: true }, logLevel: 'warn' });

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

await nodeFunction(fn, { entryPoints: ['server/vercel.ts'] });
// Swagger UI reads its assets from disk at runtime.
const swaggerUi = path.dirname(require.resolve('@fastify/swagger-ui/package.json'));
await cp(path.join(swaggerUi, 'static'), `${fn}/static`, { recursive: true });

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
        { src: '^/app$', status: 308, headers: { Location: '/app/' } },
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
