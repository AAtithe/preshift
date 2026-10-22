import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Entity, Site } from '../engine/types';

const ALL = '';
const count = (n: number) => `${n} site${n === 1 ? '' : 's'}`;
// Past this many sites the list is long enough that typing a name beats scrolling for it.
const SEARCH_FROM = 7;

/**
 * The heading is the scope: click it to choose all sites, one company or one site from a single
 * list grouped by company. The trail above it steps back out a level at a time.
 */
export function ScopePicker({ entities, sites, entityId, siteId, onChoose }: {
  entities: Entity[];
  sites: Site[];
  entityId: string;
  siteId: string;
  onChoose: (entityId: string, siteId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const site = sites.find((s) => s.id === siteId);
  const entity = entities.find((e) => e.id === (site ? site.entityId : entityId));
  const name = site ? site.name : entityId && entity ? entity.name : 'All sites';
  // With one company, the company and the group are the same thing, so only sites are listed.
  const grouped = entities.length > 1;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    // Land on the search when there is one, otherwise on the current choice.
    const first = menu.current?.querySelector<HTMLElement>('input, [aria-selected="true"]');
    first?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const go = (e: string, s: string) => {
    onChoose(e, s);
    setOpen(false);
    setQuery('');
  };

  // Up and down move through the choices, Escape closes and returns to the heading.
  function keys(e: ReactKeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      box.current?.querySelector<HTMLElement>('.sp-trigger')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('.sp-option') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? Math.min(at + 1, items.length - 1) : Math.max(at - 1, 0);
    items[next]?.focus();
  }

  const q = query.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const groups = entities
    .map((e) => ({ entity: e, all: sites.filter((s) => s.entityId === e.id) }))
    .map((g) => ({ ...g, shown: hit(g.entity.name) ? g.all : g.all.filter((s) => hit(s.name)) }))
    .filter((g) => g.shown.length > 0 || (grouped && hit(g.entity.name)));
  const option = (kind: 'all' | 'entity' | 'site', label: string, meta: string, selected: boolean, choose: () => void, key: string) => (
    <button key={key} role="option" aria-selected={selected} data-kind={kind} className={`sp-option sp-${kind}${selected ? ' selected' : ''}`} onClick={choose}>
      <span className="sp-name">{label}</span>
      <span className="sp-meta">{meta}</span>
    </button>
  );

  return (
    <div className="scopepicker" ref={box} onKeyDown={open ? keys : undefined}>
      {(site || entityId) && (
        <nav className="sp-crumbs" aria-label="Scope">
          <button className="link" onClick={() => go(ALL, ALL)}>All sites</button>
          {grouped && site && entity && (
            <>
              <span aria-hidden="true">/</span>
              <button className="link" onClick={() => go(entity.id, ALL)}>{entity.name}</button>
            </>
          )}
        </nav>
      )}
      <h1>
        <button className="sp-trigger" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label="Site or company" title="Choose a site or company">
          {name}
        </button>
      </h1>
      {open && (
        <div className={`sp-menu${grouped ? ' grouped' : ''}`} ref={menu}>
          {sites.length >= SEARCH_FROM && (
            <input className="sp-search" type="search" placeholder="Find a site or company" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a site or company" />
          )}
          <div role="listbox" aria-label="Sites and companies">
            {!q && option('all', 'All sites', grouped ? `${count(sites.length)} · ${entities.length} companies` : count(sites.length), !site && !entityId, () => go(ALL, ALL), 'all')}
            {groups.map(({ entity: e, all, shown }) => (
              <div key={e.id} className="sp-group">
                {grouped && option('entity', e.name, count(all.length), !site && entityId === e.id, () => go(e.id, ALL), e.id)}
                {shown.map((s) => option('site', s.name, '', s.id === siteId, () => go(entityId === s.entityId ? entityId : ALL, s.id), s.id))}
              </div>
            ))}
            {groups.length === 0 && <p className="muted small sp-none">No site or company matches "{query}".</p>}
          </div>
        </div>
      )}
    </div>
  );
}
