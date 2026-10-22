// The quick answers in How to are the same ones Support suggests as someone types: one library,
// so the two never disagree.
import { HELP_ARTICLES } from '../../engine/support';
import type { Guide } from './index';

function Answers() {
  return (
    <>
      <p>The questions managers ask most, and where in Preshift each one is fixed. Not here? Ask your client partner under Help, Support.</p>
      {HELP_ARTICLES.map((a) => (
        <details key={a.id} className="help-article">
          <summary>{a.title}</summary>
          <p className="small">{a.body}</p>
        </details>
      ))}
    </>
  );
}

export const answersGuide: Guide = {
  id: 'answers',
  title: 'Quick answers',
  summary: 'Publish greyed out, labour % high, clock-in failing, hours not in payroll and more',
  Body: Answers,
};
