// Builds the Vercel deployment with the Build Output API (.vercel/output):
//   /         marketing site (site/)
//   /app/     rota web app (Vite build)
//   /v1, /docs, /health   Preshift API as one bundled Node function
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

await esbuild({
  entryPoints: ['server/vercel.ts'],
  outfile: `${fn}/index.cjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logLevel: 'warning',
});
// Swagger UI reads its assets from disk at runtime.
const swaggerUi = path.dirname(require.resolve('@fastify/swagger-ui/package.json'));
await cp(path.join(swaggerUi, 'static'), `${fn}/static`, { recursive: true });

await writeFile(
  `${fn}/.vc-config.json`,
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.cjs', launcherType: 'Nodejs', shouldAddHelpers: false }, null, 2),
);

await mkdir(out, { recursive: true });
await writeFile(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/(v1(?:/.*)?|docs(?:/.*)?|health)$', dest: '/api?__p=/$1' },
        { src: '^/app$', status: 308, headers: { Location: '/app/' } },
        { handle: 'filesystem' },
      ],
    },
    null,
    2,
  ),
);

console.log(`Built ${out}`);
