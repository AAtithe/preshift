import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Shift } from '../engine/types';
import { type Edge, sameShift } from './drag';

export interface Blocked {
  employeeId: string;
  date: string;
  reason: string;
  /** Letting go here cancels the change; otherwise the shift holds at its last allowed position. */
  refuse: boolean;
}

export interface DragState {
  mode: 'move' | Edge;
  pointerType: string;
  original: Shift;
  current: Shift;
  x: number;
  y: number;
  started: boolean;
  blocked: Blocked | null;
  holdTimer?: number;
}

/** Turns pointer travel into the previewed shift for one view (grid cells, timeline lanes). */
export type Resolve = (d: DragState, e: PointerEvent, dx: number, dy: number) => { next: Shift; blocked: Blocked | null };

interface Options {
  resolve: Resolve;
  /** The scrolling element to auto-scroll; sticky bands inside it are marked data-sticky-top/bottom. */
  scroller: () => HTMLElement | null;
  onPreview: (shift: Shift | null) => void;
  onCommit: (shift: Shift, before: Shift) => void;
  onBlocked: (message: string) => void;
  onCommitted?: () => void;
}

/** Pointer travel before a mouse press becomes a drag, so a plain click still opens the editor. */
const DRAG_THRESHOLD = 4;
/** On touch a shift lifts after a short hold, so a swipe still scrolls the rota. */
const TOUCH_HOLD_MS = 300;
const TOUCH_SLOP = 8;
const EDGE_ZONE = 36;

/**
 * Drag to move and resize shifts, shared by every rota view. Handles the click threshold,
 * press-and-hold on touch, auto-scroll near edges, Escape, and refusing or holding at blocks.
 */
export function useShiftDrag(options: Options) {
  const drag = useRef<DragState | null>(null);
  const justDragged = useRef(false);
  const [pointer, setPointer] = useState<{ x: number; y: number; touch: boolean } | null>(null);
  const opts = useRef(options);
  opts.current = options;

  useEffect(() => {
    let lastEvent: PointerEvent | null = null;
    let frame = 0;

    function lift(d: DragState) {
      d.started = true;
      document.body.classList.add(d.mode === 'move' ? 'dragging-move' : 'dragging-resize');
      if (d.pointerType === 'touch') navigator.vibrate?.(10);
      setPointer({ x: d.x, y: d.y, touch: d.pointerType === 'touch' });
    }
    function move(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.started) {
        if (d.pointerType === 'touch' && d.mode === 'move') {
          // Moving before the hold completes is a scroll, not a drag.
          if (Math.hypot(dx, dy) > TOUCH_SLOP) cancelPending();
          return;
        }
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        lift(d);
      }
      const { next, blocked } = opts.current.resolve(d, e, dx, dy);
      d.blocked = blocked;
      if (!sameShift(next, d.current)) {
        d.current = next;
        opts.current.onPreview(next);
      }
      setPointer({ x: e.clientX, y: e.clientY, touch: d.pointerType === 'touch' });
      lastEvent = e;
      if (!frame) frame = requestAnimationFrame(autoScroll);
    }
    // Scroll when a lifted shift is held near the edge, so any row or day can be reached.
    function autoScroll() {
      frame = 0;
      const d = drag.current;
      const box = opts.current.scroller();
      if (!d?.started || !lastEvent || !box) return;
      const r = box.getBoundingClientRect();
      const band = (sel: string) => [...box.querySelectorAll(sel)].reduce((h, el) => h + el.getBoundingClientRect().height, 0);
      const top = r.top + band('[data-sticky-top]');
      const bottom = r.bottom - band('[data-sticky-bottom]');
      const speed = (gap: number) => Math.ceil(((EDGE_ZONE - gap) / EDGE_ZONE) * 14);
      const { clientX: x, clientY: y } = lastEvent;
      let dy = 0;
      let dx = 0;
      if (y < top + EDGE_ZONE) dy = -speed(y - top);
      else if (y > bottom - EDGE_ZONE) dy = speed(bottom - y);
      if (d.mode === 'move') {
        if (x < r.left + EDGE_ZONE) dx = -speed(x - r.left);
        else if (x > r.right - EDGE_ZONE) dx = speed(r.right - x);
      }
      const before = [box.scrollLeft, box.scrollTop];
      box.scrollBy(dx, dy);
      if (box.scrollLeft !== before[0] || box.scrollTop !== before[1]) {
        move(lastEvent);
        if (!frame) frame = requestAnimationFrame(autoScroll);
      }
    }
    function cancelPending() {
      const d = drag.current;
      if (d && !d.started) {
        window.clearTimeout(d.holdTimer);
        drag.current = null;
      }
    }
    function end(commit: boolean) {
      const d = drag.current;
      if (!d) return;
      window.clearTimeout(d.holdTimer);
      cancelAnimationFrame(frame);
      frame = 0;
      drag.current = null;
      document.body.classList.remove('dragging-move', 'dragging-resize');
      setPointer(null);
      if (!d.started) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      const o = opts.current;
      o.onPreview(null);
      if (!commit) return;
      if (d.blocked?.refuse) o.onBlocked(`Not moved. ${d.blocked.reason}`);
      else if (!sameShift(d.current, d.original)) {
        o.onCommit(d.current, d.original);
        o.onCommitted?.();
      }
    }
    function hold(e: PointerEvent) {
      const d = drag.current;
      if (d && !d.started && d.pointerType === 'touch' && d.mode === 'move') {
        window.clearTimeout(d.holdTimer);
        d.holdTimer = window.setTimeout(() => drag.current === d && lift(d), TOUCH_HOLD_MS);
        d.x = e.clientX;
        d.y = e.clientY;
      }
    }
    // Once a shift is lifted, stop the page scrolling under the finger.
    const touchMove = (e: TouchEvent) => drag.current?.started && e.cancelable && e.preventDefault();
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && end(false);
    window.addEventListener('pointerdown', hold);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    window.addEventListener('touchmove', touchMove, { passive: false });
    return () => {
      window.removeEventListener('pointerdown', hold);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      window.removeEventListener('touchmove', touchMove);
    };
  }, []);

  function startDrag(e: ReactPointerEvent<HTMLElement>, shift: Shift) {
    if (e.button !== 0) return;
    const edge = (e.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge as Edge | undefined;
    drag.current = {
      mode: edge ?? 'move',
      pointerType: e.pointerType,
      original: shift,
      current: shift,
      x: e.clientX,
      y: e.clientY,
      started: false,
      blocked: null,
    };
    if (edge) e.preventDefault();
  }

  return {
    /** The active drag once it has lifted, for rendering. */
    dragging: drag.current?.started ? drag.current : null,
    pointer,
    startDrag,
    /** True for the click that ends a drag, so it does not also open the editor. */
    wasDrag: () => justDragged.current,
  };
}
