import { useId } from 'react';

/**
 * A small (i) that explains what is beside it. The words show on hover, on keyboard focus, and on a
 * tap on a touch screen (a tap focuses the button), so nothing is explained by hover alone. The
 * explanation is the button's description, so a screen reader reads it too.
 */
export function Tip({ about, children, align = 'start' }: { about: string; children: string; align?: 'start' | 'end' }) {
  const id = useId();
  return (
    <span className={`info info-${align}`}>
      <button type="button" className="info-mark" aria-label={`About ${about}`} aria-describedby={id}>
        i
      </button>
      <span role="tooltip" id={id} className="info-text">
        {children}
      </span>
    </span>
  );
}
