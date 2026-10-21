import { GUIDES } from './guides';

/** How to: short guides for GMs, written for the job rather than the screen. */
export function HowToView({ guideId, onOpen }: { guideId: string | null; onOpen: (id: string) => void }) {
  const guide = GUIDES.find((g) => g.id === guideId) ?? GUIDES[0];
  return (
    <div className="howto">
      <nav className="howto-list" aria-label="Guides">
        {GUIDES.map((g) => (
          <button key={g.id} className={g.id === guide.id ? 'active' : ''} onClick={() => onOpen(g.id)}>
            <span className="strong">{g.title}</span>
            <span className="muted small">{g.summary}</span>
          </button>
        ))}
      </nav>
      <article className="guide">
        <h2>{guide.title}</h2>
        <p className="muted">{guide.summary}</p>
        <guide.Body />
      </article>
    </div>
  );
}
