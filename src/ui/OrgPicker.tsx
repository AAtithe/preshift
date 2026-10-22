import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { actingAsDemo } from './api';
import type { Account } from './SettingsView';

// A Williams, Stanley & Co. person can hold many clients; past this many, typing a name beats scrolling.
const SEARCH_FROM = 7;

/**
 * The organisation this session works in, at the top of the bar, since it sits above every company
 * and site. Choosing another moves the session there and reloads, so the choice is a deliberate
 * click on a named row rather than a dropdown that fires as it scrolls.
 */
export function OrgPicker({ account }: { account: Account | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const orgs = account?.organisations ?? [];

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    menu.current?.querySelector<HTMLElement>('input, [aria-selected="true"]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (orgs.length < 2 || actingAsDemo) return null;
  const current = orgs.find((o) => o.current) ?? orgs.find((o) => o.orgId === account!.orgId);

  async function choose(orgId: string, name: string) {
    if (orgId === current?.orgId) return setOpen(false);
    setError(null);
    setMoving(name);
    const res = await fetch('/auth/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId }) }).catch(() => null);
    if (res?.ok) return location.reload();
    setMoving(null);
    setError((await res?.json().catch(() => null))?.message ?? 'Could not switch. Check your connection and try again.');
  }

  // Up and down move through the organisations, Escape closes and returns to the card.
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

  const q = query.trim().toLowerCase();
  const shown = orgs.filter((o) => !q || o.name.toLowerCase().includes(q));

  return (
    <div className="orgpicker" ref={box} onKeyDown={open ? keys : undefined}>
      <button
        className="op-trigger"
        onClick={() => setOpen(!open)}
        disabled={!!moving}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Organisation: ${current?.name ?? ''}`}
      >
        <span className="op-label">Organisation</span>
        <span className="op-name">{moving ? `Opening ${moving}` : current?.name}</span>
        <span className="op-count">{orgs.length} you work in</span>
      </button>
      {open && (
        <div className="op-menu" ref={menu}>
          {orgs.length >= SEARCH_FROM && (
            <input className="op-search" type="search" placeholder="Find an organisation" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find an organisation" />
          )}
          <div role="listbox" aria-label="Organisations">
            {shown.map((o) => (
              <button
                key={o.orgId}
                role="option"
                aria-selected={o.orgId === current?.orgId}
                className={`op-option${o.orgId === current?.orgId ? ' selected' : ''}`}
                onClick={() => void choose(o.orgId, o.name)}
              >
                <span className="op-option-name">{o.name}</span>
                {o.home && <span className="op-tag">Home</span>}
              </button>
            ))}
            {shown.length === 0 && <p className="small op-none">No organisation matches "{query}".</p>}
          </div>
        </div>
      )}
      {error && <p className="small op-error" role="alert">{error}</p>}
    </div>
  );
}
