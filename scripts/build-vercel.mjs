// Builds one Vercel deployment (Build Output API v3):
//   /            marketing site (site/)
//   /app         the rota web app
//   /v1, /docs   the Preshift API as a Node function, which also serves the
//                rota assistant's Claude route at /api/anthropic
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const out = '.vercel/output';
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });
run('npx tsc -p tsconfig.json');
run(`npx vite build --base=/app/ --outDir ${out}/static/app --emptyOutDir`);
for (const f of ['index.html', 'styles.css', 'main.js', 'img']) cpSync(`site/${f}`, `${out}/static/${f}`, { recursive: true });

const fn = `${out}/functions/api.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ['server/vercel.ts'],
  outfile: `${fn}/index.js`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'info',
});
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: 'commonjs' }));
writeFileSync(
  `${fn}/.vc-config.json`,
    // The rota assistant runs a multi-turn Claude loop through this function, so allow long requests.
  JSON.stringify({ runtime: 'nodejs20.x', handler: 'index.js', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 300 }, null, 2),
);

writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/(v1/.*|docs|docs/json|health|internal/dispatch|api/anthropic/.*)$', dest: '/api' },
        { handle: 'filesystem' },
        { src: '^/app(/.*)?$', dest: '/app/index.html' },
      ],
      crons: [{ path: '/internal/dispatch', schedule: '0 6 * * *' }],
    },
    null,
    2,
  ),
);
console.log('Vercel output written to', out);
