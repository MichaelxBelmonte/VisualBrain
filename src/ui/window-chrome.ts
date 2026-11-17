// Desktop window chrome on macOS: traffic lights inside the top bar, native glass behind the shell, window theme in step with the app theme.
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
const internals = (globalThis as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
/** Inside the Mac app (not a browser tab on the same server). */
export const nativeMac = typeof internals?.invoke === 'function' && /Mac OS X|Macintosh/.test(globalThis.navigator?.userAgent ?? '');
const GLASS_KEY = 'vb:glass';

export function glassEnabled(): boolean {
  try { return localStorage.getItem(GLASS_KEY) !== 'off'; } catch { return true; }
}

export function setGlass(on: boolean): void {
  try { localStorage.setItem(GLASS_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable: applies to this window only */ }
  document.documentElement.classList.toggle('vb-glass', nativeMac && on);
}

/** The native material follows the window appearance: an app theme different from the system one must be told to the window. */
export function syncWindowTheme(): void {
  if (!nativeMac) return;
  const theme = document.documentElement.dataset.theme;
  internals!.invoke!('plugin:window|set_theme', { value: theme === 'dark' || theme === 'light' ? theme : null }).catch(() => { /* older shell without the permission */ });
}

export function mountWindowChrome(): void {
  const root = document.documentElement;
  root.classList.toggle('vb-mac-window', nativeMac);
  root.classList.toggle('vb-glass', nativeMac && glassEnabled());
  if (!nativeMac) return;
  // full screen hides the traffic lights: the top bar takes back their space
  const fullscreen = () => root.classList.toggle('vb-fullscreen', innerWidth === screen.width && innerHeight === screen.height);
  addEventListener('resize', fullscreen);
  fullscreen();
  syncWindowTheme();
}
