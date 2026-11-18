// One section at a time in a container. Each section draws into an element of its own, removed when the next one is
// shown: a renderer that answers late (a slow request, an error, a timer) writes where nobody looks and cannot replace
// what the person is reading now.
export interface SectionViews {
  /** Shows a new section: `render` gets its own root and a timer that only fires while that root is the one shown. */
  show(render: (root: HTMLElement, schedule: (fn: () => void) => void) => Promise<void>, fail: (root: HTMLElement, error: unknown) => void): HTMLElement;
  /** Nothing is shown any more: pending answers and timers of the last section are dropped. */
  close(): void;
}

export function sectionViews(body: HTMLElement, delay = 1500): SectionViews {
  let shown: HTMLElement | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  const live = (root: HTMLElement) => shown === root && root.isConnected;
  return {
    show(render, fail) {
      clearTimeout(timer);
      const root = document.createElement('div');
      shown = root; body.replaceChildren(root);
      const schedule = (fn: () => void) => { if (!live(root)) return; clearTimeout(timer); timer = setTimeout(() => { if (live(root)) fn(); }, delay); };
      void render(root, schedule).catch(error => { if (live(root)) fail(root, error); });
      return root;
    },
    close() { clearTimeout(timer); shown = null; body.replaceChildren(); },
  };
}
