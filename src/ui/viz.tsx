import type { ReactNode } from 'react';
import type { Department } from '../engine/types';

export const DEPT_COLOR: Record<Department, string> = {
  MGMT: 'var(--mgmt)',
  FOH: 'var(--foh)',
  BAR: 'var(--bar)',
  BOH: 'var(--boh)',
};

export const COMPONENTS = [
  { key: 'gross', label: 'Wages', color: 'var(--c-gross)' },
  { key: 'holiday', label: 'Holiday accrual', color: 'var(--c-holiday)' },
  { key: 'employerNi', label: 'Employer NI', color: 'var(--c-ni)' },
  { key: 'pension', label: 'Pension', color: 'var(--c-pension)' },
] as const;

export type Composition = Record<(typeof COMPONENTS)[number]['key'], number>;

export function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function Avatar({ name, dept, small }: { name: string; dept: Department; small?: boolean }) {
  return (
    <span className={`avatar${small ? ' sm' : ''}`} style={{ background: DEPT_COLOR[dept] }} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** Bullet gauge: fill to the actual, a tick at the target, on a fixed scale. */
export function Bullet({ value, target, max, mini }: { value: number; target: number; max: number; mini?: boolean }) {
  const over = value > target;
  const fill = `${Math.min(100, (value / max) * 100)}%`;
  const tick = `${Math.min(100, (target / max) * 100)}%`;
  if (mini) {
    return (
      <div className="mini-bullet" aria-hidden>
        <div className={over ? 'over' : ''} style={{ width: fill }} />
        <i style={{ left: tick }} />
      </div>
    );
  }
  return (
    <div className="bullet" aria-hidden>
      <div className={`bullet-fill${over ? ' over' : ''}`} style={{ width: fill }} />
      <div className="bullet-target" style={{ left: tick }} />
    </div>
  );
}

/** Part-to-whole bar for the loaded cost of labour. */
export function CostStack({ parts, thin }: { parts: Composition; thin?: boolean }) {
  const total = COMPONENTS.reduce((s, c) => s + parts[c.key], 0);
  if (total <= 0) return <div className={`stack${thin ? ' thin' : ''}`} style={{ background: 'var(--surface-3)' }} />;
  return (
    <div className={`stack${thin ? ' thin' : ''}`} role="img" aria-label="Cost composition">
      {COMPONENTS.map((c) =>
        parts[c.key] > 0 ? (
          <div key={c.key} style={{ flexGrow: parts[c.key], background: c.color }} title={`${c.label}: ${Math.round((parts[c.key] / total) * 100)}%`} />
        ) : null,
      )}
    </div>
  );
}

export function Tip({ x, y, title, rows }: { x: number | string; y: number | string; title: ReactNode; rows: [string, ReactNode][] }) {
  return (
    <div className="tip" style={{ left: x, top: y }}>
      <div className="tip-title">{title}</div>
      {rows.map(([k, v]) => (
        <div className="tip-row" key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

/** Round an axis maximum up to a clean tick. */
export function niceMax(n: number, ticks = 4) {
  if (n <= 0) return 1;
  const raw = n / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return step * ticks;
}

/** Column with a 4px rounded data end and a square foot on the baseline. */
export function columnPath(cx: number, width: number, base: number, height: number) {
  if (height <= 0) return '';
  const r = Math.min(4, width / 2, height);
  const x = cx - width / 2;
  return `M${x},${base}V${base - height + r}q0,-${r} ${r},-${r}h${width - 2 * r}q${r},0 ${r},${r}V${base}Z`;
}
