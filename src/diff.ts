interface Op {
  type: "eq" | "del" | "add";
  line: string;
}

/** LCS-based line ops, with common prefix/suffix trimmed first so the DP stays small. */
function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "eq", line: a[i] as string });

  // Guard: for pathological middles, emit a plain replace instead of an O(n*m) DP.
  if (midA.length * midB.length > 4_000_000) {
    for (const line of midA) ops.push({ type: "del", line });
    for (const line of midB) ops.push({ type: "add", line });
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          midA[i] === midB[j]
            ? (lcs[(i + 1) * width + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: "eq", line: midA[i] as string });
        i++;
        j++;
      } else if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)) {
        ops.push({ type: "del", line: midA[i] as string });
        i++;
      } else {
        ops.push({ type: "add", line: midB[j] as string });
        j++;
      }
    }
    while (i < n) ops.push({ type: "del", line: midA[i++] as string });
    while (j < m) ops.push({ type: "add", line: midB[j++] as string });
  }

  for (let i = endA; i < a.length; i++) ops.push({ type: "eq", line: a[i] as string });
  return ops;
}

const CONTEXT = 3;

/**
 * Unified diff of two texts. Returns "" when the texts are identical.
 * `null` on either side means the file does not exist on that side.
 */
export function unifiedDiff(oldText: string | null, newText: string | null, filePath: string): string {
  if (oldText === newText) return "";
  const a = oldText === null ? [] : oldText.split("\n");
  const b = newText === null ? [] : newText.split("\n");
  // A trailing newline produces one empty trailing element on both sides; drop it.
  if (a.length > 0 && a[a.length - 1] === "" && oldText !== "") a.pop();
  if (b.length > 0 && b[b.length - 1] === "" && newText !== "") b.pop();

  const ops = diffOps(a, b);
  if (ops.every((op) => op.type === "eq")) return "";

  const lines: string[] = [
    `--- ${oldText === null ? "/dev/null" : `a/${filePath}`}`,
    `+++ ${newText === null ? "/dev/null" : `b/${filePath}`}`,
  ];

  // Group ops into hunks with CONTEXT lines of surrounding equality.
  let oldLine = 1;
  let newLine = 1;
  let hunk: string[] = [];
  let hunkOldStart = 0;
  let hunkNewStart = 0;
  let hunkOldCount = 0;
  let hunkNewCount = 0;
  let trailingEq = 0;

  const flush = () => {
    if (hunk.length === 0) return;
    // Trim equality beyond CONTEXT at the end of the hunk.
    while (trailingEq > CONTEXT) {
      hunk.pop();
      hunkOldCount--;
      hunkNewCount--;
      trailingEq--;
    }
    lines.push(`@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`);
    lines.push(...hunk);
    hunk = [];
    trailingEq = 0;
  };

  const pending: string[] = [];
  for (const op of ops) {
    if (op.type === "eq") {
      if (hunk.length > 0) {
        hunk.push(` ${op.line}`);
        hunkOldCount++;
        hunkNewCount++;
        trailingEq++;
        if (trailingEq > CONTEXT * 2) flush();
      } else {
        pending.push(` ${op.line}`);
        if (pending.length > CONTEXT) pending.shift();
      }
      oldLine++;
      newLine++;
      continue;
    }
    if (hunk.length === 0) {
      hunkOldStart = oldLine - pending.length;
      hunkNewStart = newLine - pending.length;
      hunkOldCount = pending.length;
      hunkNewCount = pending.length;
      hunk.push(...pending);
      pending.length = 0;
    }
    trailingEq = 0;
    if (op.type === "del") {
      hunk.push(`-${op.line}`);
      hunkOldCount++;
      oldLine++;
    } else {
      hunk.push(`+${op.line}`);
      hunkNewCount++;
      newLine++;
    }
  }
  flush();
  return lines.join("\n") + "\n";
}
