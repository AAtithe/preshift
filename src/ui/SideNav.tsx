import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { NavGroup, NavItem, Tab } from './nav';

interface Props {
  groups: NavGroup[];
  active: Tab;
  onOpen: (item: NavItem) => void;
}

const KEY = 'preshift.nav.open';

// Which groups are open, by group id. Remembered in this browser only; it is a convenience.
function load(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function save(open: Record<string, boolean>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(open));
  } catch {
    // Not remembered in private mode; the bar still works.
  }
}

// Typing in a field is never a shortcut.
const typing = (el: Element | null) => !!el && (el.matches('input, textarea, select') || (el as HTMLElement).isContentEditable);

/**
 * The management bar. Any group can be opened or folded away, and that choice is remembered. Moving
 * into a section opens its group; a refresh keeps the bar as you left it. On first use only the group
 * you are in is open. A folded group lists what is in it, so nothing is hidden behind a heading. A
 * group of one needs no heading: the section's own name says it. Go to finds any section by name,
 * and / reaches it from anywhere.
 */
export function SideNav({ groups, active, onOpen }: Props) {
  const activeGroup = groups.find((g) => g.items.some((t) => t.id === active))?.id;
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const saved = load();
    return Object.keys(saved).length === 0 && activeGroup ? { [activeGroup]: true } : saved;
  });
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  const previous = useRef(activeGroup);
  useEffect(() => {
    if (!activeGroup || activeGroup === previous.current) return;
    previous.current = activeGroup;
    setOpen((o) => {
      if (o[activeGroup]) return o;
      const next = { ...o, [activeGroup]: true };
      save(next);
      return next;
    });
  }, [activeGroup]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || typing(document.activeElement)) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function toggle(id: string) {
    setOpen((o) => {
      const next = { ...o, [id]: !o[id] };
      save(next);
      return next;
    });
  }

  const q = query.trim().toLowerCase();
  // A section whose name starts with what was typed comes first, then one with a word that does, then
  // any name containing it, and last the sections of a group whose heading matches. Enter takes the top.
  const rank = (label: string, heading: string) => {
    const l = label.toLowerCase();
    if (l.startsWith(q)) return 0;
    if (l.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (l.includes(q)) return 2;
    return heading.toLowerCase().includes(q) ? 3 : -1;
  };
  const found = q
    ? groups
        .flatMap((g) => g.items.map((t) => ({ item: t, heading: g.heading, rank: rank(t.label, g.heading) })))
        .filter((f) => f.rank >= 0)
        .sort((a, b) => a.rank - b.rank)
    : [];

  function go(t: NavItem) {
    setQuery('');
    search.current?.blur();
    onOpen(t);
  }

  // Enter opens the first match, down moves into the matches, Escape clears.
  function searchKeys(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQuery('');
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && found[0]) {
      e.preventDefault();
      go(found[0].item);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      results.current?.querySelector<HTMLElement>('button')?.focus();
    }
  }

  function resultKeys(e: ReactKeyboardEvent) {
    if (e.key === 'Escape') {
      setQuery('');
      search.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(results.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowUp' && at <= 0) return search.current?.focus();
    items[e.key === 'ArrowDown' ? Math.min(at + 1, items.length - 1) : at - 1]?.focus();
  }

  const entry = (t: NavItem, meta?: string) => (
    <button
      key={t.id}
      className={active === t.id ? 'active' : ''}
      aria-current={active === t.id ? 'page' : undefined}
      onClick={() => go(t)}
    >
      {t.label}
      {meta && <span className="nav-where">{meta}</span>}
    </button>
  );

  return (
    <nav className="side-nav" aria-label="Management">
      <div className="nav-search">
        <input
          ref={search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={searchKeys}
          placeholder="Go to a section"
          aria-label="Go to a section"
        />
        {!query && <kbd aria-hidden="true">/</kbd>}
      </div>
      {q ? (
        <div className="nav-results nav-items" ref={results} onKeyDown={resultKeys}>
          {found.map(({ item, heading }) => entry(item, heading))}
          {found.length === 0 && <p className="nav-none">No section called "{query}".</p>}
        </div>
      ) : (
        groups.map((group) => {
          const folds = group.items.length > 1;
          const isOpen = !folds || !!open[group.id];
          const listId = `nav-${group.id}`;
          return (
            <div key={group.id} className={`nav-group${folds ? '' : ' single'}`} data-group={group.id}>
              {folds && (
                <button className="nav-toggle" aria-expanded={isOpen} aria-controls={listId} onClick={() => toggle(group.id)}>
                  <span className="nav-title">{group.heading}</span>
                  {!isOpen && <span className="nav-preview">{group.items.map((t) => t.label).join(', ')}</span>}
                </button>
              )}
              {isOpen && (
                <div id={listId} className="nav-items">
                  {group.items.map((t) => entry(t))}
                </div>
              )}
            </div>
          );
        })
      )}
    </nav>
  );
}
