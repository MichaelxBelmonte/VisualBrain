
// Reordering rows with the pointer. HTML5 drag and drop is not used: the desktop shell takes over drags for file drops, so it never reaches the page.

export interface ReorderOptions {
  rows: HTMLElement[];
  idOf(row: HTMLElement): string;
  /** A dedicated handle avoids dragging terminal text or interacting controls. */
  handleOf?(row: HTMLElement): HTMLElement | null;
  layout?: 'list' | 'grid';
  /** Called once, on release, with the dragged id and the id it now goes in front of (null: last). */
  onMove(id: string, before: string | null): void;
}

interface Rect { left: number; top: number; width: number; height: number }
/** Insertion target for a wrapped grid, including movement across rows. */
export function gridDropTarget(rects: Rect[], x: number, y: number): number | null {
  if (!rects.length) return null;
  const distance = (r: Rect) => Math.max(r.left - x, 0, x - r.left - r.width) ** 2 + Math.max(r.top - y, 0, y - r.top - r.height) ** 2;
  let nearest = 0;
  rects.forEach((r, i) => { if (distance(r) < distance(rects[nearest])) nearest = i; });
  const r = rects[nearest];
  const after = y > r.top + r.height || (y >= r.top && x >= r.left + r.width / 2);
  const at = nearest + Number(after);
  return at === rects.length ? null : at;
}

const THRESHOLD = 5;

/** The row the pointer is above, as "go in front of this one" (null: after all the others). Pure, so it can be tested. */
export function dropTarget(mids: number[], y: number): number | null {
  const i = mids.findIndex(mid => y < mid);
  return i < 0 ? null : i;
}

export function bindReorder({ rows, idOf, onMove, handleOf, layout = 'list' }: ReorderOptions): () => void {
  const cleanup: (() => void)[] = [];
  let activeCancel: (() => void) | undefined;
  for (const row of rows) {
    const handle = handleOf ? handleOf(row) : row;
    if (!handle) continue;
    handle.style.touchAction = 'none';
    const down = (down: PointerEvent) => {
      if (down.button !== 0 || (down.target as HTMLElement).closest('.work-remove, .work-close, .work-fold')) return;
      activeCancel?.();
      const others = () => rows.filter(r => r !== row);
      let dragging = false, before: HTMLElement | null = null;
      const clear = () => rows.forEach(r => r.classList.remove('drop-before', 'drop-end'));
      const move = (e: PointerEvent) => {
        if (e.pointerId !== down.pointerId) return;
        if (!dragging) {
          if ((layout === 'grid' ? Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) : Math.abs(e.clientY - down.clientY)) < THRESHOLD) return;
          dragging = true; row.classList.add('dragging'); document.body.classList.add('reordering');
        }
        if (!row.isConnected) { stop(false); return; }
        const rest = others();
        e.preventDefault();
        const at = layout === 'grid' ? gridDropTarget(rest.map(r => r.getBoundingClientRect()), e.clientX, e.clientY)
          : dropTarget(rest.map(r => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; }), e.clientY);
        before = at === null ? null : rest[at];
        clear();
        (before ?? rest[rest.length - 1])?.classList.add(before ? 'drop-before' : 'drop-end');
      };
      const key = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(false); };
      const up = (e: PointerEvent) => { if (e.pointerId === down.pointerId) stop(true); };
      const stop = (commit: boolean) => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', key, true);
        window.removeEventListener('blur', cancel); activeCancel = undefined;
        clear(); row.classList.remove('dragging'); document.body.classList.remove('reordering');
        if (!dragging) return;
        // The click that follows a drag must not open the row.
        const swallow = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
        document.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', swallow, true), 0);
        const at = rows.indexOf(row);
        if (commit && before !== rows[at + 1] && !(before === null && at === rows.length - 1)) onMove(idOf(row), before ? idOf(before) : null);
      };
      const cancel = () => stop(false);
      activeCancel = cancel;
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key, true);
      window.addEventListener('blur', cancel);
    };
    handle.addEventListener('pointerdown', down);
    cleanup.push(() => handle.removeEventListener('pointerdown', down));
  }
  return () => { activeCancel?.(); cleanup.forEach(fn => fn()); };
}
