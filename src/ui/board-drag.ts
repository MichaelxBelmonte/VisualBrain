// Cards of the Lavoro board dragged between and inside columns. Pointer events, not HTML5 drag: the Tauri shell takes
// drags over for file drops (see work-reorder.ts). A copy of the card follows the pointer, a line shows where it lands;
// Esc, a lost window or a cancelled pointer put everything back. The keyboard equivalent lives in work-board.ts.
export interface LaneBox { lane: string; left: number; right: number; top: number; bottom: number; mids: number[] }

/** The column under the point (the nearest one when between them) and the index among its cards. Pure. */
export function laneDropTarget(lanes: LaneBox[], x: number, y: number): { lane: string; index: number } | null {
  if (!lanes.length) return null;
  const distance = (b: LaneBox) => Math.hypot(x < b.left ? b.left - x : x > b.right ? x - b.right : 0, y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0);
  const box = lanes.reduce((best, b) => distance(b) < distance(best) ? b : best);
  const index = box.mids.findIndex(mid => y < mid);
  return { lane: box.lane, index: index < 0 ? box.mids.length : index };
}

export function bindLaneDrag(root: HTMLElement, opts: {
  /** The card under a pointerdown that may be dragged, or null. */
  card(target: HTMLElement): HTMLElement | null;
  onDrop(cardId: string, lane: string, index: number): void;
  /** True while a card is in the air: the board must not repaint under it. */
  onState(dragging: boolean): void;
}): () => void {
  let cancel: (() => void) | null = null;
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || cancel) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, button, a, [contenteditable]')) return;
    const card = opts.card(target);
    if (!card) return;
    const startX = event.clientX, startY = event.clientY;
    let ghost: HTMLElement | null = null, line: HTMLElement | null = null, drop: { lane: string; index: number } | null = null, dx = 0, dy = 0;
    const boxes = (): LaneBox[] => [...root.querySelectorAll<HTMLElement>('[data-drop-lane]')].map(section => {
      const r = section.getBoundingClientRect();
      const cards = [...section.querySelectorAll<HTMLElement>('.lavoro-cards > .lavoro-card:not(.dragging):not([hidden])')];
      return { lane: section.dataset.dropLane!, left: r.left, right: r.right, top: r.top, bottom: r.bottom, mids: cards.map(c => { const b = c.getBoundingClientRect(); return b.top + b.height / 2; }) };
    });
    const place = (x: number, y: number) => {
      drop = laneDropTarget(boxes(), x, y);
      root.querySelectorAll('.lane-target').forEach(s => s.classList.remove('lane-target'));
      if (!drop || !line) return;
      const section = root.querySelector<HTMLElement>(`[data-drop-lane="${CSS.escape(drop.lane)}"]`)!;
      section.classList.add('lane-target');
      const list = section.querySelector('.lavoro-cards')!;
      const cards = [...list.querySelectorAll<HTMLElement>(':scope > .lavoro-card:not(.dragging):not([hidden])')];
      list.insertBefore(line, cards[drop.index] ?? null);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      if (!ghost) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
        const r = card.getBoundingClientRect();
        dx = startX - r.left; dy = startY - r.top;
        ghost = card.cloneNode(true) as HTMLElement;
        ghost.classList.add('lavoro-ghost'); ghost.removeAttribute('id'); ghost.setAttribute('aria-hidden', 'true');
        ghost.style.width = `${r.width}px`;
        document.body.append(ghost);
        line = document.createElement('div'); line.className = 'lavoro-drop-line'; line.setAttribute('aria-hidden', 'true');
        card.classList.add('dragging');
        document.body.classList.add('board-dragging');
        opts.onState(true);
      }
      e.preventDefault();
      ghost.style.transform = `translate(${e.clientX - dx}px, ${e.clientY - dy}px) rotate(1.5deg)`;
      place(e.clientX, e.clientY);
    };
    const stop = (commit: boolean) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', lost); document.removeEventListener('keydown', escape, true); window.removeEventListener('blur', lost);
      cancel = null;
      if (!ghost) return;
      ghost.remove(); line?.remove();
      card.classList.remove('dragging'); document.body.classList.remove('board-dragging');
      root.querySelectorAll('.lane-target').forEach(s => s.classList.remove('lane-target'));
      // The click that ends a drag must not also open the card.
      const swallow = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      opts.onState(false);
      if (commit && drop) opts.onDrop(card.dataset.card!, drop.lane, drop.index);
    };
    const up = (e: PointerEvent) => { if (e.pointerId === event.pointerId) stop(true); };
    const lost = () => stop(false);
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(false); } };
    cancel = () => stop(false);
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', lost); document.addEventListener('keydown', escape, true); window.addEventListener('blur', lost);
  };
  root.addEventListener('pointerdown', down);
  return () => { cancel?.(); root.removeEventListener('pointerdown', down); };
}
