// What a terminal shows right now, as plain rows of text: enough of a VT100 to read the full-screen CLIs that redraw only
// the cells that changed (Codex) or rewrite their last lines (Claude Code). Colours and attributes are ignored.
const CSI = /^\x1b\[([0-?]*)[ -/]*([@-~])/;
const OSC = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const STRING = /^\x1b[P^_][^\x1b]*\x1b\\/;
const CHARSET = /^\x1b[()*+][0-9A-Za-z]/;
const UNFINISHED = /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[P^_][^\x1b]*|[()*+])?$/;

export class Screen {
  readonly cols: number;
  readonly rows: number;
  private cells: string[][];
  private x = 0;
  private y = 0;
  private top = 0;
  private bottom: number;
  private saved: [number, number] = [0, 0];
  private rest = '';

  constructor(cols: number, rows: number) {
    this.cols = Math.max(2, cols); this.rows = Math.max(2, rows); this.bottom = this.rows - 1;
    this.cells = Array.from({ length: this.rows }, () => this.blank());
  }

  private blank(): string[] { return Array<string>(this.cols).fill(' '); }

  write(data: string): void {
    const s = this.rest + data; this.rest = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\x1b') {
        const tail = s.slice(i, i + 4096);
        let m: RegExpExecArray | null;
        if ((m = CSI.exec(tail))) { this.csi(m[1], m[2]); i += m[0].length - 1; continue; }
        if ((m = OSC.exec(tail)) || (m = STRING.exec(tail)) || (m = CHARSET.exec(tail))) { i += m[0].length - 1; continue; }
        if (UNFINISHED.test(s.slice(i)) && s.length - i < 4096) { this.rest = s.slice(i); return; }
        const next = s[i + 1];
        if (next === 'M') this.reverseIndex();
        else if (next === 'D') this.lineFeed();
        else if (next === 'E') { this.x = 0; this.lineFeed(); }
        else if (next === '7') this.saved = [this.x, this.y];
        else if (next === '8') [this.x, this.y] = this.saved;
        if (next !== undefined) i++;
        continue;
      }
      if (ch === '\r') { this.x = 0; continue; }
      if (ch === '\n') { this.lineFeed(); continue; }
      if (ch === '\b') { this.x = Math.max(0, this.x - 1); continue; }
      if (ch === '\t') { this.x = Math.min(this.cols - 1, (this.x & ~7) + 8); continue; }
      if (ch < ' ' || ch === '\x7f') continue;
      const code = ch.codePointAt(0)!;
      if (code >= 0xdc00 && code <= 0xdfff) continue;               // second half of a pair already written
      if (code === 0xfe0f || code === 0x200d || (code >= 0x300 && code <= 0x36f)) continue; // no cell of their own
      if (this.x >= this.cols) { this.x = 0; this.lineFeed(); }
      this.cells[this.y][this.x++] = code >= 0xd800 && code <= 0xdbff ? ch + (s[i + 1] ?? '') : ch;
    }
  }

  private lineFeed(): void {
    if (this.y === this.bottom) { this.cells.splice(this.top, 1); this.cells.splice(this.bottom, 0, this.blank()); }
    else if (this.y < this.rows - 1) this.y++;
  }

  private reverseIndex(): void {
    if (this.y === this.top) { this.cells.splice(this.bottom, 1); this.cells.splice(this.top, 0, this.blank()); }
    else if (this.y > 0) this.y--;
  }

  private csi(params: string, final: string): void {
    if (params.startsWith('?') || params.startsWith('>') || params.startsWith('<') || params.startsWith('=')) return; // modes, replies
    const p = params.split(';').map(n => Number(n) || 0), n = p[0] || 1;
    const row = (v: number) => Math.min(this.rows - 1, Math.max(0, v)), col = (v: number) => Math.min(this.cols - 1, Math.max(0, v));
    switch (final) {
      case 'H': case 'f': this.y = row((p[0] || 1) - 1); this.x = col((p[1] || 1) - 1); break;
      case 'A': this.y = row(this.y - n); break;
      case 'B': case 'e': this.y = row(this.y + n); break;
      case 'C': case 'a': this.x = col(this.x + n); break;
      case 'D': this.x = col(this.x - n); break;
      case 'G': case '`': this.x = col(n - 1); break;
      case 'd': this.y = row(n - 1); break;
      case 'E': this.x = 0; this.y = row(this.y + n); break;
      case 'F': this.x = 0; this.y = row(this.y - n); break;
      case 's': this.saved = [this.x, this.y]; break;
      case 'u': [this.x, this.y] = this.saved; break;
      case 'K': {
        const from = p[0] === 0 ? this.x : 0, to = p[0] === 1 ? this.x + 1 : this.cols;
        for (let c = from; c < to && c < this.cols; c++) this.cells[this.y][c] = ' ';
        break;
      }
      case 'J':
        if (p[0] === 2 || p[0] === 3) this.cells = Array.from({ length: this.rows }, () => this.blank());
        else if (p[0] === 1) { for (let r = 0; r < this.y; r++) this.cells[r] = this.blank(); for (let c = 0; c <= this.x && c < this.cols; c++) this.cells[this.y][c] = ' '; }
        else { for (let c = this.x; c < this.cols; c++) this.cells[this.y][c] = ' '; for (let r = this.y + 1; r < this.rows; r++) this.cells[r] = this.blank(); }
        break;
      case 'X': for (let c = this.x; c < this.x + n && c < this.cols; c++) this.cells[this.y][c] = ' '; break;
      case 'P': this.cells[this.y].splice(this.x, n); while (this.cells[this.y].length < this.cols) this.cells[this.y].push(' '); break;
      case '@': this.cells[this.y].splice(this.x, 0, ...Array<string>(n).fill(' ')); this.cells[this.y].length = this.cols; break;
      case 'r': this.top = row((p[0] || 1) - 1); this.bottom = row((p[1] || this.rows) - 1); if (this.top >= this.bottom) { this.top = 0; this.bottom = this.rows - 1; } this.x = 0; this.y = 0; break;
      case 'L': if (this.y >= this.top && this.y <= this.bottom) for (let k = 0; k < n; k++) { this.cells.splice(this.bottom, 1); this.cells.splice(this.y, 0, this.blank()); } break;
      case 'M': if (this.y >= this.top && this.y <= this.bottom) for (let k = 0; k < n; k++) { this.cells.splice(this.y, 1); this.cells.splice(this.bottom, 0, this.blank()); } break;
      case 'S': for (let k = 0; k < n; k++) { this.cells.splice(this.top, 1); this.cells.splice(this.bottom, 0, this.blank()); } break;
      case 'T': for (let k = 0; k < n; k++) { this.cells.splice(this.bottom, 1); this.cells.splice(this.top, 0, this.blank()); } break;
    }
  }

  /** The rows as text, trailing spaces removed. */
  lines(): string[] { return this.cells.map(row => row.join('').replace(/\s+$/, '')); }
}
