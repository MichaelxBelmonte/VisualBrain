// Lanes of the commit graph (newest first, as `git log --date-order` lists them). Pure: no DOM.
// Each lane holds the commit it waits for; a commit takes its lane (or a free one), passes it to its first parent and
// opens lanes for the other parents. Lanes keep their column, so a line that just passes through stays straight.

export interface GraphCommit { hash: string; parents: string[] }
export interface GraphRow {
  col: number;
  /** Lanes entering the row from above and leaving it below. */
  top: (string | null)[];
  bottom: (string | null)[];
}

export function graphRows(commits: GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const top = lanes.slice();
    let col = lanes.indexOf(c.hash);
    if (col < 0) {
      col = lanes.indexOf(null);
      if (col < 0) { col = lanes.length; lanes.push(null); }
    }
    // Other lanes waiting for this commit end here (the branches it was merged from or forked into).
    for (let j = 0; j < lanes.length; j++) if (j !== col && lanes[j] === c.hash) lanes[j] = null;
    lanes[col] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      if (lanes.includes(p)) continue;
      let k = lanes.indexOf(null);
      if (k < 0) { k = lanes.length; lanes.push(null); }
      lanes[k] = p;
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ col, top, bottom: lanes.slice() });
  }
  return rows;
}

export interface Segment { x1: number; y1: number; x2: number; y2: number; lane: number }

/**
 * Lines of one row in lane units: y 0 is the top edge, 0.5 the commit dot, 1 the bottom edge.
 * Lines passing through keep their lane; lines into the dot come from lanes waiting for it; lines out go to its parents.
 */
export function rowSegments(row: GraphRow, parents: string[], hash: string): Segment[] {
  const out: Segment[] = [];
  row.top.forEach((v, j) => {
    if (v === null) return;
    if (v === hash) { out.push({ x1: j, y1: 0, x2: row.col, y2: 0.5, lane: j }); return; }
    const k = row.bottom[j] === v ? j : row.bottom.indexOf(v);
    if (k >= 0) out.push({ x1: j, y1: 0, x2: k, y2: 1, lane: j });
  });
  for (const p of parents) {
    const k = row.bottom[row.col] === p ? row.col : row.bottom.indexOf(p);
    if (k >= 0) out.push({ x1: row.col, y1: 0.5, x2: k, y2: 1, lane: k === row.col ? row.col : k });
  }
  return out;
}

/** "refs" from git log %D: HEAD -> main, origin/main, tag: v1 → badges with their kind; `remotes` tells feature/x from origin/x. */
export function refBadges(refs: string[], remotes: string[] = ['origin']): { text: string; kind: 'head' | 'local' | 'remote' | 'tag' }[] {
  const out: { text: string; kind: 'head' | 'local' | 'remote' | 'tag' }[] = [];
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) out.push({ text: r.slice(8), kind: 'head' });
    else if (r === 'HEAD') out.push({ text: 'HEAD', kind: 'head' });
    else if (r.startsWith('tag: ')) out.push({ text: r.slice(5), kind: 'tag' });
    else out.push({ text: r, kind: remotes.includes(r.split('/')[0]) ? 'remote' : 'local' });
  }
  return out;
}
