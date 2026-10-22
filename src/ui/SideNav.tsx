import { useEffect, useRef, useState } from 'react';
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

/**
 * The management bar. Any group can be opened or folded away, and that choice is remembered. Moving
 * into a section opens its group; a refresh keeps the bar as you left it. On first use only the group
 * you are in is open. A group of one has nothing to fold away, so it shows as a plain heading.
 */
export function SideNav({ groups, active, onOpen }: Props) {
  const activeGroup = groups.find((g) => g.items.some((t) => t.id === active))?.id;
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const saved = load();
    return Object.keys(saved).length === 0 && activeGroup ? { [activeGroup]: true } : saved;
  });

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

  function toggle(id: string) {
    setOpen((o) => {
      const next = { ...o, [id]: !o[id] };
      save(next);
      return next;
    });
  }

  return (
    <nav className="side-nav" aria-label="Management">
      {groups.map((group) => {
        const folds = group.items.length > 1;
        const isOpen = !folds || !!open[group.id];
        const listId = `nav-${group.id}`;
        return (
          <div key={group.id} className="nav-group" data-group={group.id}>
            {folds ? (
              <button className="nav-heading nav-toggle" aria-expanded={isOpen} aria-controls={listId} onClick={() => toggle(group.id)}>
                {group.heading}
                {!isOpen && <span className="nav-count">{group.items.length}</span>}
              </button>
            ) : (
              <div className="nav-heading">{group.heading}</div>
            )}
            {isOpen && (
              <div id={listId} className="nav-items">
                {group.items.map((t) => (
                  <button
                    key={t.id}
                    className={active === t.id ? 'active' : ''}
                    aria-current={active === t.id ? 'page' : undefined}
                    onClick={() => onOpen(t)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
