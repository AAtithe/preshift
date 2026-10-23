import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Me } from './access/model';
import { actingAsDemo, canSwitchDemo, demoPeople, signInAsDemo } from './api';

interface DemoPerson { id: string; name: string; jobTitle?: string; status: string }

// A seeded group has a few dozen people; past this many, typing a name beats scrolling for it.
const SEARCH_FROM = 7;

/**
 * Development builds only: see the app as any seeded person, to check what their roles allow.
 * It sits in the bar under the organisation, since it changes who is looking at every screen.
 */
export function DemoPicker({ me }: { me: Me | null }) {
  const [people, setPeople] = useState<DemoPerson[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (canSwitchDemo) void demoPeople<DemoPerson[]>().then(setPeople).catch(() => setPeople(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    menu.current?.querySelector<HTMLElement>('input, [aria-selected="true"]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (!people) return null;
  const current = actingAsDemo ? me?.user?.id ?? '' : '';
  const active = people.filter((p) => p.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
  const q = query.trim().toLowerCase();
  const shown = active.filter((p) => !q || `${p.name} ${p.jobTitle ?? ''}`.toLowerCase().includes(q));

  const choose = (id: string) => {
    setOpen(false);
    if (id !== current) signInAsDemo(id || null);
  };

  // Up and down move through the people, Escape closes and returns to the card.
  function keys(e: ReactKeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      box.current?.querySelector<HTMLElement>('.op-trigger')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('.op-option') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[e.key === 'ArrowDown' ? Math.min(at + 1, items.length - 1) : Math.max(at - 1, 0)]?.focus();
  }

  const person = (id: string, name: string, meta: string) => (
    <button key={id || 'own'} role="option" aria-selected={id === current} className={`op-option${id === current ? ' selected' : ''}`} onClick={() => choose(id)}>
      <span className="op-option-name">{name}</span>
      {meta && <span className="op-meta">{meta}</span>}
    </button>
  );

  return (
    <div className={`orgpicker demopicker${actingAsDemo ? ' acting' : ''}`} ref={box} onKeyDown={open ? keys : undefined}>
      <button className="op-trigger" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label="Viewing as">
        <span className="op-label">Demo: viewing as</span>
        <span className="op-name">{actingAsDemo ? me?.user?.name ?? 'Someone else' : 'Yourself'}</span>
        <span className="op-count">{actingAsDemo ? me?.user?.jobTitle ?? 'Their roles only' : `${active.length} people to try`}</span>
      </button>
      {open && (
        <div className="op-menu" ref={menu}>
          {active.length >= SEARCH_FROM && (
            <input className="op-search" type="search" placeholder="Find a person or job" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a person or job" />
          )}
          <div role="listbox" aria-label="People">
            {!q && person('', 'Yourself', 'Your own sign-in')}
            {shown.map((p) => person(p.id, p.name, p.jobTitle ?? ''))}
            {shown.length === 0 && <p className="small op-none">Nobody matches "{query}".</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** While acting as someone else, every screen says so, with the way back one click away. */
export function DemoBanner({ me }: { me: Me | null }) {
  if (!actingAsDemo) return null;
  const who = me?.user ? `${me.user.name}${me.user.jobTitle ? `, ${me.user.jobTitle}` : ''}` : 'a demo person';
  return (
    <div className="acting-banner" role="status">
      <span>You are viewing the app as <strong>{who}</strong>. Everything here is what their roles allow.</span>
      <button onClick={() => signInAsDemo(null)}>Back to yourself</button>
    </div>
  );
}
