import { describe, expect, it } from 'vitest';
import type { RotaDraft } from '../rotaTools';
import { CASES, grade, WEEK } from './cases';

// Proves the graders before a paid run: every reference solution passes, and doing nothing fails
// wherever action was needed. A broken grader shows up here, not as a mysterious model score.
describe('rota assistant evaluation set', () => {
  it('has unique ids and covers both directions', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    expect(CASES.some((c) => c.nullPasses)).toBe(true);
    expect(CASES.filter((c) => !c.nullPasses).length).toBeGreaterThan(10);
  });

  for (const c of CASES) {
    const run = (solve: (d: RotaDraft) => string) => {
      const { state, insights } = c.setup();
      const before = structuredClone(state);
      const draft: RotaDraft = { state: structuredClone(state), siteIds: c.siteIds, weekStart: WEEK, now: c.now, insights };
      const summary = solve(draft);
      return grade(c, { before, after: draft.state, summary, siteIds: c.siteIds, now: c.now });
    };

    it(`${c.id}: the reference solution passes`, () => {
      const result = run(c.oracle);
      expect(result.checks.filter((x) => !x.pass)).toEqual([]);
    });

    it(`${c.id}: doing nothing ${c.nullPasses ? 'passes, as it should' : 'fails'}`, () => {
      const result = run(() => 'Done.');
      expect(result.pass).toBe(Boolean(c.nullPasses));
    });
  }
});
