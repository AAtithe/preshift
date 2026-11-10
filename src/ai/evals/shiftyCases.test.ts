import { describe, expect, it } from 'vitest';
import { CASES, grade, type ShiftyCase, type TurnResult } from './shiftyCases';

// Proves Shifty's graders before a paid run: every reference answer passes, and doing nothing (no
// cards, "Done.") fails every case. A broken grader shows up here, not as a mysterious model score.
describe('Shifty evaluation set', () => {
  it('has unique ids and covers every kind of request', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    expect(new Set(CASES.map((c) => c.tags[0]))).toEqual(new Set(['action', 'ask_first', 'refuse', 'question', 'confirmation']));
    for (const c of CASES) expect(c.oracle).toHaveLength(c.turns.length);
  });

  const run = async (c: ShiftyCase, answer: (turn: number) => Promise<TurnResult>) => {
    const turns: TurnResult[] = [];
    for (let i = 0; i < c.turns.length; i++) turns.push(await answer(i));
    return grade(c, { ctx: c.setup(), turns });
  };

  for (const c of CASES) {
    it(`${c.id}: the reference answer passes`, async () => {
      const ctx = c.setup();
      const result = await run(c, (i) => c.oracle[i](ctx));
      expect(result.checks.filter((x) => !x.pass)).toEqual([]);
    });

    it(`${c.id}: doing nothing fails`, async () => {
      const result = await run(c, async () => ({ proposals: [], reply: 'Done.' }));
      expect(result.pass).toBe(false);
    });
  }

  it('catches a reply that says the change is made before the manager confirms', async () => {
    const c = CASES.find((x) => x.id === 'add-starter')!;
    const ctx = c.setup();
    const good = await c.oracle[0](ctx);
    const result = await grade(c, { ctx: c.setup(), turns: [{ ...good, reply: "I've added Sam Lee as a bartender." }] });
    expect(result.checks.find((x) => x.name === 'not_claimed_done')?.pass).toBe(false);
  });

  it('catches personal data in a reply', async () => {
    const c = CASES.find((x) => x.id === 'ni-request')!;
    const result = await grade(c, { ctx: c.setup(), turns: [{ proposals: [], reply: "I can't share it, but it is QQ 12 34 56 C." }] });
    expect(result.checks.find((x) => x.name === 'private_kept')?.pass).toBe(false);
  });
});
