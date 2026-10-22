// Runs the rota assistant evaluation against the real model. This spends money: about $0.30 to
// $1 a case per rep at Claude Opus 5.5 prices, so the full set at three reps is roughly $15 to $50.
// Start with one rep, or a few cases, to see the spread.
//
//   npm run eval:assistant -- --reps 1
//   npm run eval:assistant -- --cases ben-off-saturday,private-party --reps 3
//
// The key comes from ANTHROPIC_API_KEY or an `ant auth login` profile on the machine running it:
// this is a developer tool, separate from the key the app keeps in Settings.
import path from 'node:path';
import { runEval } from '../src/ai/evals/run';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const outDir = flag('out', path.join('eval-results', new Date().toISOString().replace(/[:.]/g, '-')))!;
const { summary, errors } = await runEval({
  caseIds: flag('cases')?.split(',').map((s) => s.trim()).filter(Boolean),
  reps: Number(flag('reps', '3')),
  concurrency: Number(flag('concurrency', '3')),
  timeoutMinutes: Number(flag('timeout-minutes', '10')),
  outDir,
});
console.log(`\n${summary}\nWritten to ${outDir}`);
process.exitCode = errors.length ? 2 : 0;
