// Runs the API and the web app together for local development.
import { spawn } from 'node:child_process';

const procs = ['dev:api', 'dev:web'].map((script) =>
  spawn('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' }),
);
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
