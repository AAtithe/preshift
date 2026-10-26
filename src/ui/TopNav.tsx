import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { NavGroup, NavItem, Tab } from './nav';

interface Props {
  groups: NavGroup[];
  active: Tab;
  onOpen: (item: NavItem) => void;
  /** Right of the bar: What's new and the account menu. */
  end?: ReactNode;
}

// Typing in a field is never a shortcut.
const typing = (el: Element | null) => !!el && (el.matches('input, textarea, select') || (el as HTMLElement).isContentEditable);

/**
 * The management bar, across the top so the screen below it is the work's. Each group opens as a
 * menu, one at a time, every section with a line on what it is for; choosing one, pressing Escape or
 * clicking elsewhere closes it. A group of one needs no menu: the section's own name says it. The
 * group you are in is marked, so the bar says where you are with every menu shut. Go to finds any
 * section by name, and / reaches it from anywhere. On a phone the whole bar folds behind Menu.
 */
export function TopNav({ groups, active, onOpen, end }: Props) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [folded, setFolded] = useState(true);
  const [query, setQuery] = useState('');
  const bar = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const activeGroup = groups.find((g) => g.items.some((t) => t.id === active))?.id;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || typing(document.activeElement)) return;
      e.preventDefault();
      setFolded(false);
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A menu left open closes as soon as the pointer goes down anywhere outside the bar.
  useEffect(() => {
    if (!openGroup && !query) return;
    const away = (e: PointerEvent) => {
      if (bar.current?.contains(e.target as Node)) return;
      setOpenGroup(null);
      setQuery('');
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [openGroup, query]);

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
    setOpenGroup(null);
    setFolded(true);
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

  // Up and down move through a list of sections; Escape closes it and returns to where it opened.
  function listKeys(e: ReactKeyboardEvent, back: () => void) {
    if (e.key === 'Escape') {
      e.preventDefault();
      back();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowUp' && at <= 0) return back();
    items[e.key === 'ArrowDown' ? Math.min(at + 1, items.length - 1) : at - 1]?.focus();
  }

  const entry = (t: NavItem, meta?: string) => (
    <button
      key={t.id}
      className={active === t.id ? 'active' : ''}
      aria-current={active === t.id ? 'page' : undefined}
      aria-label={t.label}
      aria-describedby={`nav-hint-${t.id}`}
      onClick={() => go(t)}
    >
      {meta && <span className="nav-where">{meta}</span>}
      <span className="nav-label">{t.label}</span>
      <span className="nav-hint" id={`nav-hint-${t.id}`}>{t.hint}</span>
    </button>
  );

  return (
    <nav
      ref={bar}
      className={`top-nav${folded ? '' : ' unfolded'}`}
      aria-label="Management"
      onKeyDown={(e) => {
        // Escape on a group's own button closes its menu; inside a menu, the menu's keys handle it.
        if (e.key !== 'Escape' || !openGroup || (e.target as HTMLElement).closest('.nav-menu')) return;
        setOpenGroup(null);
      }}
    >
      <button className="nav-menu-toggle" aria-expanded={!folded} aria-controls="nav-body" onClick={() => setFolded(!folded)}>
        Menu
      </button>
      <div id="nav-body" className="nav-body">
        <div className="nav-groups">
          {groups.map((group) => {
            const current = group.id === activeGroup;
            if (group.items.length === 1) {
              const t = group.items[0];
              return (
                <div key={group.id} className="nav-group single" data-group={group.id}>
                  <button
                    className={`nav-direct${current ? ' current' : ''}`}
                    aria-current={active === t.id ? 'page' : undefined}
                    title={t.hint}
                    onClick={() => go(t)}
                  >
                    {t.label}
                  </button>
                </div>
              );
            }
            const isOpen = openGroup === group.id;
            const listId = `nav-${group.id}`;
            return (
              <div key={group.id} className="nav-group" data-group={group.id}>
                <button
                  className={`nav-toggle${current ? ' current' : ''}`}
                  aria-expanded={isOpen}
                  aria-controls={listId}
                  title={group.items.map((t) => t.label).join(', ')}
                  onClick={() => setOpenGroup(isOpen ? null : group.id)}
                >
                  {group.heading}
                </button>
                {isOpen && (
                  <div
                    id={listId}
                    className="nav-menu nav-items"
                    onKeyDown={(e) => listKeys(e, () => {
                      setOpenGroup(null);
                      bar.current?.querySelector<HTMLElement>(`[data-group="${group.id}"] .nav-toggle`)?.focus();
                    })}
                  >
                    {group.items.map((t) => entry(t))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="nav-search">
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpenGroup(null); }}
            onKeyDown={searchKeys}
            placeholder="Go to a section"
            aria-label="Go to a section"
          />
          {!query && <kbd aria-hidden="true">/</kbd>}
          {q && (
            <div className="nav-menu nav-results nav-items" ref={results} onKeyDown={(e) => listKeys(e, () => search.current?.focus())}>
              {found.map(({ item, heading }) => entry(item, heading))}
              {found.length === 0 && <p className="nav-none">No section called "{query}".</p>}
            </div>
          )}
        </div>
        {end && <div className="nav-end">{end}</div>}
      </div>
    </nav>
  );
}

/**
 * The account menu at the end of the bar: whose organisation you are in, who you are viewing as in a
 * development build, and signing out. It stays open while a picker inside it is in use, so Escape in
 * a picker closes that picker and not the menu around it.
 */
export function AccountMenu({ initial, children }: { initial: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <div
      className="account"
      ref={box}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.orgpicker')) setOpen(false);
      }}
    >
      <button className="account-toggle" aria-label="Account" aria-expanded={open} onClick={() => setOpen(!open)}>
        {initial}
      </button>
      {open && <div className="account-menu">{children}</div>}
    </div>
  );
}
