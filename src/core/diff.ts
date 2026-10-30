// Line-based unified diff (Myers algorithm), no dependencies.

type Op = { type: 'equal' | 'add' | 'del'; line: string };

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Backtrack.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', line: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'add', line: b[y - 1] });
      else ops.push({ type: 'del', line: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface DiffOptions {
  context?: number;
  color?: boolean;
}

const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** Returns a unified diff for one file; `before` null means a new file, `after` null a deleted one. */
export function unifiedDiff(path: string, before: string | null, after: string | null, opts: DiffOptions = {}): string {
  const ctx = opts.context ?? 3;
  const color = opts.color ?? false;
  const paint = (fn: (s: string) => string, s: string) => (color ? fn(s) : s);
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const ops = diffLines(a, b);
  if (!ops.some((o) => o.type !== 'equal')) return '';

  const header = [paint(C.bold, `--- ${before === null ? '/dev/null' : `a/${path}`}`), paint(C.bold, `+++ ${after === null ? '/dev/null' : `b/${path}`}`)];
  const hunks: string[] = [];
  // Group changes into hunks with context.
  let i = 0;
  let aLine = 1;
  let bLine = 1;
  const positions: { aLine: number; bLine: number }[] = [];
  for (const op of ops) {
    positions.push({ aLine, bLine });
    if (op.type !== 'add') aLine++;
    if (op.type !== 'del') bLine++;
  }
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }
    let start = Math.max(0, i - ctx);
    let end = i;
    // Extend the hunk while changes are within 2*ctx of each other.
    while (end < ops.length) {
      if (ops[end].type !== 'equal') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run].type === 'equal') run++;
      if (end + run >= ops.length || run > ctx * 2) {
        end = Math.min(ops.length, end + Math.min(run, ctx));
        break;
      }
      end += run;
    }
    const slice = ops.slice(start, end);
    const aStart = positions[start].aLine;
    const bStart = positions[start].bLine;
    const aCount = slice.filter((o) => o.type !== 'add').length;
    const bCount = slice.filter((o) => o.type !== 'del').length;
    const lines = [paint(C.cyan, `@@ -${aCount === 0 ? aStart - 1 : aStart},${aCount} +${bCount === 0 ? bStart - 1 : bStart},${bCount} @@`)];
    for (const op of slice) {
      if (op.type === 'equal') lines.push(` ${op.line}`);
      else if (op.type === 'add') lines.push(paint(C.green, `+${op.line}`));
      else lines.push(paint(C.red, `-${op.line}`));
    }
    hunks.push(lines.join('\n'));
    i = end;
    start = end;
  }
  return [...header, ...hunks].join('\n') + '\n';
}

export function diffStats(before: string | null, after: string | null): { added: number; removed: number } {
  const ops = diffLines(splitLines(before ?? ''), splitLines(after ?? ''));
  return { added: ops.filter((o) => o.type === 'add').length, removed: ops.filter((o) => o.type === 'del').length };
}
