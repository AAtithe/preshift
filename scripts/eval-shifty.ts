// Runs Shifty's evaluation against the real model. This spends money: each case is one or two short
// conversations with a few tool calls. Start with one rep: summary.md reports what it cost, which is
// the figure to plan larger runs from.
//
//   npm run eval:shifty -- --reps 1
//   npm run eval:shifty -- --cases sick-cover,starter-missing-dob --reps 3
//
// The key comes from ANTHROPIC_API_KEY or an `ant auth login` profile on the machine running it:
// this is a developer tool, separate from the key the app keeps in Settings.
import path from 'node:path';
import { runShiftyEval } from '../src/ai/evals/shiftyRun';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const outDir = flag('out', path.join('eval-results', `shifty-${new Date().toISOString().replace(/[:.]/g, '-')}`))!;
const { summary, errors } = await runShiftyEval({
  caseIds: flag('cases')?.split(',').map((s) => s.trim()).filter(Boolean),
  reps: Number(flag('reps', '3')),
  concurrency: Number(flag('concurrency', '3')),
  timeoutMinutes: Number(flag('timeout-minutes', '5')),
  outDir,
});
console.log(`\n${summary}\nWritten to ${outDir}`);
process.exitCode = errors.length ? 2 : 0;
