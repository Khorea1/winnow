/** Keep annotations and entries appended after validation began. */
export function pruneValidatedLines(content: string, checked: ReadonlySet<string>, valid: ReadonlySet<string>): string | null {
  const lines = content.split('\n');
  const kept = lines.filter((line) => {
    const proxy = line.trim();
    return !proxy || proxy.startsWith('#') || !checked.has(proxy) || valid.has(proxy);
  });
  return kept.length === lines.length ? null : kept.join('\n');
}

/** Add only entries absent from the latest contents, preserving the original lines. */
export function appendUniqueProxies(content: string, proxies: readonly string[]): { content: string | null; added: number } {
  const existing = new Set(content.split('\n').map((line) => line.trim()));
  const additions = proxies.filter((proxy) => {
    if (existing.has(proxy)) return false;
    existing.add(proxy);
    return true;
  });
  if (!additions.length) return { content: null, added: 0 };
  const prefix = content ? (content.endsWith('\n') ? content : `${content}\n`) : '';
  return { content: `${prefix}${additions.join('\n')}\n`, added: additions.length };
}

/** Replace validated entries while retaining annotations in an existing output file. */
export function replaceValidatedProxies(content: string, proxies: readonly string[]): string {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop(); // A terminal newline is not an extra blank line.
  const annotations = lines.filter((line) => !line.trim() || line.trimStart().startsWith('#'));
  return `${[...annotations, ...proxies].join('\n')}\n`;
}
