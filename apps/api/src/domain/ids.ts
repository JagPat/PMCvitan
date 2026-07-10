/** Next sequential display id for a prefix, e.g. nextSeqId('DL-', ['DL-014','DL-020']) → 'DL-021'.
 *  Ignores ids that don't match the prefix or lack a numeric suffix; starts at 1 when none. */
export function nextSeqId(prefix: string, existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    if (!id.startsWith(prefix)) continue;
    const n = parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}
