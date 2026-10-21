import { useEffect, type ReactNode } from 'react';

/** A small dialog for guidance at the moment it is needed. Escape or a click outside closes it. */
export function HelpModal({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
        </div>
        <div className="modal-body guide">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}
