import { useEffect, useRef } from 'react';

export const DISCARD = 'Close without saving your changes?';

/**
 * How an editing dialog closes: Escape, the backdrop or Cancel all come through here, and with
 * unsaved changes the person is asked first, so a stray click outside never throws work away.
 */
export function useDialogClose(dirty: boolean, onClose: () => void) {
  const live = useRef({ dirty, onClose });
  live.current = { dirty, onClose };
  const request = () => {
    if (live.current.dirty && !window.confirm(DISCARD)) return;
    live.current.onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      request();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // request reads the latest values through the ref, so the listener is added once.
  }, []);
  return request;
}
