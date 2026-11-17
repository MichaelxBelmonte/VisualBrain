/*! Icon paths from Lucide 1.66.0 (https://lucide.dev), each shape turned into a path.
 * ISC License. Copyright (c) 2026 Lucide Icons and Contributors.
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
 * provided that the above copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
 * CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
 * NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 * Icons derived from Feather: MIT License, Copyright (c) 2013-2023 Cole Bemis. */
// One stroke, size and optical weight for shell controls and map nodes. No icon font or network request.
import type { GraphNode } from '../shared/types.ts';

const paths = {
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'], // folder
  connect: ['M5 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-4a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2Z', 'M7 11v4a2 2 0 0 0 2 2h4', 'M15 13h4a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-4a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2Z'], // workflow
  terminal: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2Z', 'm7 11 2-2-2-2', 'M11 13h4'], // square-terminal
  panelCollapse: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2Z', 'M9 3v18', 'm16 15-3-3 3-3'], // panel-left-close
  panelExpand: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2Z', 'M9 3v18', 'm14 9 3 3-3 3'], // panel-left-open
  more: ['M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'], // ellipsis
  plus: ['M5 12h14', 'M12 5v14'], // plus
  search: ['m21 21-4.34-4.34', 'M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0'], // search
  settings: ['M10 5H3', 'M12 19H3', 'M14 3v4', 'M16 17v4', 'M21 12h-9', 'M21 19h-5', 'M21 5h-7', 'M8 10v4', 'M8 12H3'], // sliders-horizontal
  single: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2Z'], // square
  grid: ['M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1Z', 'M15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1Z', 'M15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1Z', 'M4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1Z'], // layout-grid
  chevron: ['m6 9 6 6 6-6'], // chevron-down
  edit: ['M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z', 'm15 5 4 4'], // pencil
  context: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5', 'M10 9H8', 'M16 13H8', 'M16 17H8'], // file-text
  hide: ['M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49', 'M14.084 14.158a3 3 0 0 1-4.242-4.242', 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143', 'm2 2 20 20'], // eye-off
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'], // refresh-cw
  close: ['M18 6 6 18', 'm6 6 12 12'], // x
} as const;
export function icon(name: keyof typeof paths): string {
  return `<svg class="ui-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name].map(d => `<path d="${d}"/>`).join('')}</svg>`;
}

export function mountIcons(): void {
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (name && Object.hasOwn(paths, name)) el.innerHTML = icon(name as keyof typeof paths);
  });
}

/** Map glyphs by node class; folders without a role of their own use the folder icon. */
const glyphs: Record<string, readonly string[]> = {
  folder: paths.folder,
  project: ['M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z', 'm3.3 7 8.7 5 8.7-5', 'M12 22V12'], // box
  dump: ['M13 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M20.9 19.8A2 2 0 0 0 22 18V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5.1', 'M15 11v-1', 'M15 17v-2'], // folder-archive
  vendor: ['M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z', 'M12 22V12', 'M3.29 7L12 12L20.71 7', 'm7.5 4.27 9 5.15'], // package
  media: ['m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16', 'M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2', 'M12 7a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M10 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2Z'], // images
  code: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5', 'M10 12.5 8 15l2 2.5', 'm14 12.5 2 2.5-2 2.5'], // file-code
  doc: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5', 'M10 9H8', 'M16 13H8', 'M16 17H8'], // file-text
  data: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5', 'M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1', 'M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1'], // file-braces
  sheet: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5', 'M8 13h2', 'M14 13h2', 'M8 17h2', 'M14 17h2'], // file-spreadsheet
  image: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5', 'M8 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'm20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22'], // file-image
  video: ['M4 12V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2', 'M14 2v5a1 1 0 0 0 1 1h5', 'm10 17.843 3.033-1.755a.64.64 0 0 1 .967.56v4.704a.65.65 0 0 1-.967.56L10 20.157', 'M4 16h5a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1Z'], // file-video-camera
  audio: ['M11.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v10.35', 'M14 2v5a1 1 0 0 0 1 1h5', 'M8 20v-7l3 1.474', 'M4 20a2 2 0 1 0 4 0a2 2 0 1 0 -4 0'], // file-music
  archive: ['M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5', 'M14 2v5a1 1 0 0 0 1 1h5', 'M8 12v-1', 'M8 18v-2', 'M8 7V6', 'M6 20a2 2 0 1 0 4 0a2 2 0 1 0 -4 0'], // file-archive
  binary: ['M16 14h0a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h0a2 2 0 0 1 -2 -2v-2a2 2 0 0 1 2 -2Z', 'M8 4h0a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h0a2 2 0 0 1 -2 -2v-2a2 2 0 0 1 2 -2Z', 'M6 20h4', 'M14 10h4', 'M6 14h2v6', 'M14 4h2v6'], // binary
  config: ['M15 8a1 1 0 0 1-1-1V2a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8z', 'M20 8v12a2 2 0 0 1-2 2h-4.182', 'm3.305 19.53.923-.382', 'M4 10.592V4a2 2 0 0 1 2-2h8', 'm4.228 16.852-.924-.383', 'm5.852 15.228-.383-.923', 'm5.852 20.772-.383.924', 'm8.148 15.228.383-.923', 'm8.53 21.696-.382-.924', 'm9.773 16.852.922-.383', 'm9.773 19.148.922.383', 'M4 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0'], // file-cog
  notebook: ['M2 6h4', 'M2 10h4', 'M2 14h4', 'M2 18h4', 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-16a2 2 0 0 1 2 -2Z', 'M16 2v20'], // notebook
  log: ['M15 12h-5', 'M15 8h-5', 'M19 17V5a2 2 0 0 0-2-2H4', 'M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3'], // scroll-text
  font: ['M12 4v16', 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2', 'M9 20h6'], // type
  secret: ['M4 9.8V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3', 'M14 2v5a1 1 0 0 0 1 1h5', 'M9 17v-2a2 2 0 0 0-4 0v2', 'M4 17h6a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1Z'], // file-lock
  other: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5'], // file
  symlink: ['M4 11V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h7', 'M14 2v5a1 1 0 0 0 1 1h5', 'm10 18 3-3-3-3'], // file-symlink
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'], // external-link
};

/** The glyph drawn before a node's name on the map, or null for groups, sessions and the "rest" boxes. */
export function glyphOf(n: Pick<GraphNode, 'kind' | 'cls'>): string | null {
  if (n.kind === 'area' || n.cls === 'rest' || n.cls === 'session') return null;
  if (n.kind === 'external') return 'external';
  if (n.kind === 'symlink') return 'symlink';
  if (Object.hasOwn(glyphs, n.cls)) return n.cls;
  return n.kind === 'dir' ? 'folder' : 'other';
}

const compiled = new Map<string, Path2D[]>();
/** Strokes a glyph in a size×size square at (x, y) with the current stroke style. */
export function drawGlyph(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, size: number): void {
  let list = compiled.get(name);
  if (!list) { list = (glyphs[name] ?? glyphs.other).map(d => new Path2D(d)); compiled.set(name, list); }
  const k = size / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.lineWidth = 1.75;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const p of list) ctx.stroke(p);
  ctx.restore();
}
